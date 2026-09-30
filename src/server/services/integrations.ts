import { z } from 'zod';
import type { Asset, FieldRule, IntegrationSource, Prisma, RenewableType } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { AppError, badRequest, conflict, notFound } from '@/lib/errors';
import { dateOnly } from '@/lib/format';
import { SYSTEM_ACTOR, type Actor } from '../actor';
import { audit } from '../audit';
import { randomToken, sha256 } from '../auth/tokens';
import { decryptSecret, encryptSecret, safeEqualHex } from '../crypto';
import { adminUserIds, itUserIds, notifyUsers } from '../notify';
import { hit } from '../rate-limit';
import { requireRole } from '../scope';
import { createAssetInput, findDuplicates, insertAsset } from './assets';
import { syncWarrantyRenewable, upsertExpiryFromSource } from './renewables';

/**
 * Vendor-neutral device integration (FR-INT-02…11). One hook serves every source
 * system; patch data is stored for display only (FR-INT-10) — nothing here ever
 * performs, schedules or verifies patching.
 */

/** Asset fields a source may write, subject to its per-field rule (FR-INT-06, 08). */
export const SYNCABLE_FIELDS = ['hostname', 'ipAddress', 'macAddress', 'warrantyEnd'] as const;
type SyncField = (typeof SYNCABLE_FIELDS)[number];
/** Employee fields owned by a directory source (FR-INT-01, FR-EMP-04). */
export const DIRECTORY_FIELDS = ['name', 'email', 'departmentId', 'managerId', 'active'] as const;

const EXPIRY_TYPES = ['WARRANTY', 'LICENCE', 'SUBSCRIPTION', 'AMC', 'CALIBRATION', 'INSURANCE', 'CERTIFICATE', 'OTHER'] as const;
const optS = (max = 200) => z.union([z.string(), z.number()]).transform((v) => String(v).trim().slice(0, max)).nullable().optional();
const optDate = z.string().nullable().optional().transform((v, ctx) => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) { ctx.addIssue({ code: 'custom', message: `Invalid date "${v}"` }); return z.NEVER; }
  return d;
});

export const deviceRecord = z.object({
  externalId: optS(200),
  serialNumber: optS(120),
  hostname: optS(120),
  ipAddress: optS(60),
  macAddress: optS(40),
  legacyTag: optS(80),
  os: optS(120),
  osVersion: optS(120),
  lastSeen: optDate,
  currentUser: optS(200),
  applications: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(2000).optional(),
  patchStatus: optS(120),
  lastPatched: optDate,
  warrantyEnd: optDate,
  make: optS(120),
  model: optS(160),
  expiries: z.array(z.object({ type: z.enum(EXPIRY_TYPES).default('OTHER'), label: z.string().trim().min(1).max(200), expiry: z.string(), identifier: optS(200), vendor: optS(160) })).max(50).optional(),
  timestamp: optDate,
});
export type DeviceRecord = z.infer<typeof deviceRecord>;

export const batchInput = z.object({
  batchId: z.string().trim().min(1).max(200).optional(),
  records: z.array(z.record(z.string(), z.unknown())).min(1, 'records must contain at least one item').max(5000, 'At most 5,000 records per batch'),
});

// ───────────── Source administration ─────────────

export const sourceInput = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use 2–41 lowercase letters, digits or dashes'),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['DEVICE', 'DIRECTORY']).default('DEVICE'),
  active: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
  autoCreate: z.boolean().default(false),
  autoCreateCategoryId: z.string().nullable().optional(),
  autoCreateLocationId: z.string().nullable().optional(),
  secondaryMatchKey: z.enum(['none', 'hostname', 'mac', 'legacyTag']).default('none'),
  pullEnabled: z.boolean().default(false),
  pullIntervalMinutes: z.number().int().min(15).max(10_080).nullable().optional(),
  /** Pull: {url, recordsPath, authHeader, fieldMap}; Directory: {url, bindDN, baseDN, filter, attributes} */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Write-only: bearer token / bind password. Empty string clears; undefined keeps. */
  secret: z.string().max(4000).optional(),
  mappings: z.array(z.object({ field: z.string(), rule: z.enum(['OVERWRITE', 'WARN', 'IGNORE']) })).optional(),
});

function publicSource(s: IntegrationSource & { mappings?: { field: string; rule: FieldRule }[] }) {
  const { apiKeyHash: _h, secretEnc, ...rest } = s;
  return { ...rest, hasApiKey: !!s.apiKeyHash && !s.apiKeyRevokedAt, hasSecret: !!secretEnc };
}

export async function listSources(actor: Actor) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const rows = await prisma.integrationSource.findMany({ orderBy: { name: 'asc' }, include: { mappings: true } });
  return rows.map(publicSource);
}

export async function getSource(actor: Actor, id: string) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const s = await prisma.integrationSource.findUnique({ where: { id }, include: { mappings: true } });
  if (!s) throw notFound('Integration source');
  return publicSource(s);
}

export async function saveSource(actor: Actor, id: string | null, input: unknown) {
  requireRole(actor, 'ADMIN');
  const d = sourceInput.parse(input);
  if (d.autoCreate && d.kind === 'DEVICE' && (!d.autoCreateCategoryId || !d.autoCreateLocationId)) throw badRequest('Auto-create needs a default category and location for new devices.');
  const fields: readonly string[] = d.kind === 'DIRECTORY' ? DIRECTORY_FIELDS : SYNCABLE_FIELDS;
  const bad = (d.mappings ?? []).filter((m) => !fields.includes(m.field));
  if (bad.length) throw badRequest(`Unknown field(s): ${bad.map((b) => b.field).join(', ')}`);
  const data = {
    key: d.key, name: d.name, kind: d.kind, active: d.active, rateLimitPerMinute: d.rateLimitPerMinute, autoCreate: d.autoCreate,
    autoCreateCategoryId: d.autoCreateCategoryId || null, autoCreateLocationId: d.autoCreateLocationId || null,
    secondaryMatchKey: d.secondaryMatchKey, pullEnabled: d.pullEnabled, pullIntervalMinutes: d.pullIntervalMinutes ?? null,
    config: d.config as Prisma.InputJsonValue,
    ...(d.secret !== undefined ? { secretEnc: d.secret ? encryptSecret(d.secret) : null } : {}),
  };
  return tx(async (t) => {
    const before = id ? await t.integrationSource.findUnique({ where: { id } }) : null;
    if (id && !before) throw notFound('Integration source');
    const s = id ? await t.integrationSource.update({ where: { id }, data }) : await t.integrationSource.create({ data });
    if (d.mappings) {
      for (const m of d.mappings) await t.integrationMapping.upsert({ where: { sourceId_field: { sourceId: s.id, field: m.field } }, create: { sourceId: s.id, field: m.field, rule: m.rule }, update: { rule: m.rule } });
    } else if (!id) {
      // Last-write-wins is not the default (FR-INT-08): every field starts as "warn on conflict".
      for (const f of fields) await t.integrationMapping.create({ data: { sourceId: s.id, field: f, rule: 'WARN' } });
    }
    await audit(t, actor, {
      action: id ? 'INTEGRATION_SOURCE_UPDATED' : 'INTEGRATION_SOURCE_CREATED', entityType: 'IntegrationSource', entityId: s.id, entityLabel: s.name,
      details: { key: s.key, kind: s.kind, secretChanged: d.secret !== undefined, mappings: d.mappings, config: redactConfig(d.config) },
    });
    return publicSource({ ...s, mappings: await t.integrationMapping.findMany({ where: { sourceId: s.id } }) });
  });
}

function redactConfig(c: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, /secret|password|token|key/i.test(k) ? '[redacted]' : v]));
}

/** FR-INT-03: one credential per source. The plaintext is shown once and only its hash is stored. */
export async function issueApiKey(actor: Actor, sourceId: string) {
  requireRole(actor, 'ADMIN');
  const s = await prisma.integrationSource.findUnique({ where: { id: sourceId } });
  if (!s) throw notFound('Integration source');
  if (s.kind !== 'DEVICE') throw badRequest('API keys apply to device sources only.');
  const prefix = randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).padEnd(8, '0');
  const plain = `itam_${prefix}_${randomToken(32)}`;
  await prisma.integrationSource.update({ where: { id: s.id }, data: { apiKeyHash: sha256(plain), apiKeyPrefix: prefix, apiKeyRevokedAt: null } });
  await audit(prisma, actor, { action: s.apiKeyHash ? 'INTEGRATION_KEY_ROTATED' : 'INTEGRATION_KEY_ISSUED', entityType: 'IntegrationSource', entityId: s.id, entityLabel: s.name, details: { prefix } });
  return { apiKey: plain, prefix };
}

export async function revokeApiKey(actor: Actor, sourceId: string) {
  requireRole(actor, 'ADMIN');
  const s = await prisma.integrationSource.findUnique({ where: { id: sourceId } });
  if (!s) throw notFound('Integration source');
  // Hash is removed as well, so a revoked key can never authenticate again.
  await prisma.integrationSource.update({ where: { id: s.id }, data: { apiKeyRevokedAt: new Date(), apiKeyHash: null } });
  await audit(prisma, actor, { action: 'INTEGRATION_KEY_REVOKED', entityType: 'IntegrationSource', entityId: s.id, entityLabel: s.name, details: { prefix: s.apiKeyPrefix } });
}

/** Authenticate an inbound call; every attempt, good or bad, is logged (FR-INT-03). */
export async function authenticateSource(sourceKey: string, authHeader: string | null, ip: string | null) {
  const token = authHeader?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
  const s = await prisma.integrationSource.findUnique({ where: { key: sourceKey } });
  const ok = !!s && s.active && s.kind === 'DEVICE' && !!s.apiKeyHash && !s.apiKeyRevokedAt && !!token && safeEqualHex(sha256(token), s.apiKeyHash);
  if (!ok) {
    await audit(prisma, null, { action: 'INTEGRATION_AUTH_FAILED', entityType: 'IntegrationSource', entityId: s?.id ?? null, entityLabel: sourceKey, details: { reason: !s ? 'unknown source' : !token ? 'missing credential' : s.apiKeyRevokedAt || !s.apiKeyHash ? 'revoked credential' : !s.active ? 'source inactive' : 'invalid credential', ip, keyPrefix: token?.split('_')[1] ?? null } });
    throw new AppError(401, 'UNAUTHORIZED', 'Missing, invalid or revoked API credential.');
  }
  if (!(await hit(`int:${s!.id}`, s!.rateLimitPerMinute, 60))) {
    await audit(prisma, null, { action: 'INTEGRATION_THROTTLED', entityType: 'IntegrationSource', entityId: s!.id, entityLabel: s!.name, details: { limitPerMinute: s!.rateLimitPerMinute, ip } });
    throw new AppError(429, 'RATE_LIMITED', `Rate limit of ${s!.rateLimitPerMinute} calls per minute exceeded. Retry after the current minute.`);
  }
  return s!;
}

// ───────────── Batch processing ─────────────

const integrationActor = (s: IntegrationSource): Actor => ({ ...SYSTEM_ACTOR, name: `Integration: ${s.name}` });

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Per-source field mapping: {"serial_no": "serialNumber", "device.name": "hostname"} (FR-INT-06). */
function applyFieldMap(raw: Record<string, unknown>, fieldMap: Record<string, string> | undefined) {
  if (!fieldMap || !Object.keys(fieldMap).length) return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const [from, to] of Object.entries(fieldMap)) {
    const v = from.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], raw);
    if (v !== undefined) out[to] = v;
  }
  return out;
}

interface RunCounts { received: number; created: number; updated: number; unchanged: number; conflicts: number; rejected: number; unmatched: number }
interface RunNote { record: number; externalId?: string | null; serial?: string | null; level: 'error' | 'info'; message: string }

export async function processBatch(source: IntegrationSource, input: unknown, opts: { mode?: 'PUSH' | 'PULL' | 'RETRY'; retryOfRunId?: string } = {}) {
  const parsed = batchInput.safeParse(input);
  if (!parsed.success) throw badRequest('Invalid batch payload.', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  const { batchId, records } = parsed.data;
  const payloadHash = sha256(stableStringify(records));
  const mode = opts.mode ?? 'PUSH';

  // FR-INT-09: identical payloads (same batch id, or same content already applied) have no effect.
  if (mode !== 'RETRY') {
    const prior = batchId
      ? await prisma.integrationRun.findUnique({ where: { sourceId_batchId: { sourceId: source.id, batchId } } })
      : await prisma.integrationRun.findFirst({ where: { sourceId: source.id, payloadHash, status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' } });
    if (prior) {
      const dup = await prisma.integrationRun.create({ data: { sourceId: source.id, payloadHash, mode, status: 'DUPLICATE', received: records.length, unchanged: records.length, finishedAt: new Date(), errors: [{ record: 0, level: 'info', message: `Already applied in run ${prior.id}${batchId ? ` (batch ${batchId})` : ''}; no changes made.` }] } });
      return { runId: dup.id, status: 'DUPLICATE' as const, alreadyApplied: true, priorRunId: prior.id, counts: countsOf(dup) };
    }
  }

  const run = await prisma.integrationRun.create({ data: { sourceId: source.id, batchId: mode === 'RETRY' ? null : batchId ?? null, payloadHash, mode, received: records.length, payload: { batchId, records } as Prisma.InputJsonValue, retryOfRunId: opts.retryOfRunId ?? null } });
  const mappings = await prisma.integrationMapping.findMany({ where: { sourceId: source.id } });
  const rules = new Map<string, FieldRule>(mappings.map((m) => [m.field, m.rule]));
  const fieldMap = (source.config as { fieldMap?: Record<string, string> }).fieldMap;
  const counts: RunCounts = { received: records.length, created: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, unmatched: 0 };
  const notes: RunNote[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = deviceRecord.safeParse(applyFieldMap(records[i], fieldMap));
    if (!rec.success) {
      counts.rejected++;
      notes.push({ record: i + 1, level: 'error', message: rec.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      continue;
    }
    try {
      const outcome = await tx((t) => applyRecord(t, source, rec.data, rules, run.id, i + 1, notes));
      counts[outcome.result]++;
      counts.conflicts += outcome.conflicts;
    } catch (e) {
      counts.rejected++;
      notes.push({ record: i + 1, externalId: rec.data.externalId, serial: rec.data.serialNumber, level: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const errors = notes.filter((n) => n.level === 'error').length;
  const status = errors === 0 ? 'SUCCESS' : errors === records.length ? 'FAILED' : 'PARTIAL';
  const done = await prisma.integrationRun.update({ where: { id: run.id }, data: { ...counts, status, errors: notes.slice(0, 1000) as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
  await prisma.integrationSource.update({ where: { id: source.id }, data: { lastRunAt: new Date(), ...(status !== 'FAILED' ? { lastSuccessAt: new Date() } : {}) } });
  await audit(prisma, integrationActor(source), { action: 'INTEGRATION_RUN', entityType: 'IntegrationRun', entityId: run.id, entityLabel: `${source.name} ${mode}`, details: { ...counts, status, batchId } });
  await notifyRunOutcome(source, run.id, status, counts);
  return { runId: run.id, status, alreadyApplied: false, counts: countsOf(done), errors: notes.filter((n) => n.level === 'error').slice(0, 50) };
}

/** Matrix §A4.14: integration failure or unmatched surge → Administrators by email; conflicts → IT in-app. */
const UNMATCHED_SURGE = 10;
async function notifyRunOutcome(source: IntegrationSource, runId: string, status: string, counts: RunCounts) {
  const summary = `${counts.received} received · ${counts.created} created · ${counts.updated} updated · ${counts.conflicts} conflicts · ${counts.rejected} rejected · ${counts.unmatched} unmatched`;
  if (status !== 'SUCCESS' || counts.unmatched >= UNMATCHED_SURGE) {
    await notifyUsers(prisma, await adminUserIds(prisma), {
      type: 'INTEGRATION_FAILURE', title: status !== 'SUCCESS' ? `${source.name}: run ${status.toLowerCase()}` : `${source.name}: ${counts.unmatched} unmatched devices`,
      body: summary, link: `/integrations/sources/${source.id}`, eventKey: `integration-run:${runId}:admin`,
    });
  }
  if (counts.conflicts > 0) {
    await notifyUsers(prisma, await itUserIds(prisma), { type: 'INTEGRATION', title: `${source.name}: ${counts.conflicts} field conflict(s) to review`, body: summary, link: `/integrations/conflicts`, eventKey: `integration-run:${runId}:conflicts`, email: false });
  }
}

function countsOf(r: RunCounts) {
  const { received, created, updated, unchanged, conflicts, rejected, unmatched } = r;
  return { received, created, updated, unchanged, conflicts, rejected, unmatched };
}

async function matchAsset(t: Db, source: IntegrationSource, r: DeviceRecord): Promise<Asset | null> {
  if (r.serialNumber) {
    const a = await t.asset.findFirst({ where: { serialNormalized: r.serialNumber.trim().toLowerCase() } });
    if (a) return a;
  }
  const key = source.secondaryMatchKey;
  let where: Prisma.AssetWhereInput | null = null;
  if (key === 'hostname' && r.hostname) where = { hostnameNormalized: r.hostname.trim().toLowerCase() };
  if (key === 'mac' && r.macAddress) where = { macAddress: { equals: r.macAddress.trim(), mode: 'insensitive' } };
  if (key === 'legacyTag' && r.legacyTag) where = { legacyTagNormalized: r.legacyTag.trim().toLowerCase() };
  if (!where) return null;
  const hits = await t.asset.findMany({ where: { ...where, status: { not: 'RETIRED' } }, take: 2 });
  return hits.length === 1 ? hits[0] : null; // ambiguous secondary matches go to review
}

const asText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v));

async function applyRecord(t: Prisma.TransactionClient, source: IntegrationSource, r: DeviceRecord, rules: Map<string, FieldRule>, runId: string, n: number, notes: RunNote[]): Promise<{ result: 'created' | 'updated' | 'unchanged' | 'unmatched'; conflicts: number }> {
  const actor = integrationActor(source);
  let asset = await matchAsset(t, source, r);
  if (!asset) {
    if (!source.autoCreate) {
      await queueUnmatched(t, source, r, runId);
      return { result: 'unmatched', conflicts: 0 };
    }
    asset = await autoCreate(t, source, r);
    await upsertSourceData(t, source, asset.id, r);
    await applyExpiries(t, source, asset, r);
    notes.push({ record: n, externalId: r.externalId, serial: r.serialNumber, level: 'info', message: `Created ${asset.assetCode}` });
    return { result: 'created', conflicts: 0 };
  }
  const known = await t.assetSourceData.findUnique({ where: { assetId_sourceKey: { assetId: asset.id, sourceKey: source.key } } });
  if (r.timestamp && known?.sourceTimestamp && r.timestamp <= known.sourceTimestamp) return { result: 'unchanged', conflicts: 0 };

  const changes: Record<string, unknown> = {};
  const fieldSources = { ...(asset.fieldSources as Record<string, string>) };
  let conflicts = 0;
  for (const f of SYNCABLE_FIELDS) {
    const incoming = r[f];
    if (incoming === undefined || incoming === null || incoming === '') continue;
    const inVal = f === 'warrantyEnd' ? dateOnly((incoming as Date).toISOString().slice(0, 10)) : incoming;
    const cur = asset[f as keyof Asset];
    if (asText(cur) === asText(inVal)) { if (!fieldSources[f]) fieldSources[f] = source.key; continue; }
    const rule = rules.get(f) ?? 'WARN';
    if (asset.status === 'RETIRED') { notes.push({ record: n, serial: r.serialNumber, level: 'info', message: `${asset.assetCode} is retired; ${f} not updated` }); continue; }
    if (rule === 'IGNORE') { notes.push({ record: n, serial: r.serialNumber, level: 'info', message: `${asset.assetCode}.${f}: inbound "${asText(inVal)}" ignored (rule: ignore); kept "${asText(cur) ?? ''}"` }); continue; }
    const owned = cur === null || cur === undefined || fieldSources[f] === source.key;
    if (rule === 'OVERWRITE' || owned) {
      changes[f] = inVal;
      fieldSources[f] = source.key;
    } else {
      await queueConflict(t, source, { entityType: 'ASSET', entityId: asset.id, entityLabel: asset.assetCode, field: f, currentValue: asText(cur), incomingValue: asText(inVal), runId });
      conflicts++;
    }
  }
  if (changes.hostname || changes.ipAddress) {
    const dups = (await findDuplicates(t, { hostname: changes.hostname as string, ipAddress: changes.ipAddress as string }, asset.id)).filter((d) => d.severity === 'WARN');
    if (dups.length) notes.push({ record: n, serial: r.serialNumber, level: 'info', message: `${asset.assetCode}: ${dups.map((d) => `${d.key} ${d.value} also on ${d.match.assetCode}`).join('; ')}` });
  }
  const sourceChanged = await upsertSourceData(t, source, asset.id, r);
  const expiryChanged = await applyExpiries(t, source, asset, r);
  if (Object.keys(changes).length) {
    const updated = await t.asset.update({ where: { id: asset.id }, data: { ...changes, fieldSources, updatedById: null } });
    await audit(t, actor, { action: 'INTEGRATION_UPDATE', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: Object.fromEntries(Object.keys(changes).map((k) => [k, asset![k as keyof Asset]])), after: changes, details: { source: source.key, runId }, locationIds: asset.locationId ? [asset.locationId] : [] });
    if ('warrantyEnd' in changes) await syncWarrantyRenewable(t, actor, updated, source.key);
    return { result: 'updated', conflicts };
  }
  return { result: sourceChanged || expiryChanged ? 'updated' : 'unchanged', conflicts };
}

async function upsertSourceData(t: Db, source: IntegrationSource, assetId: string, r: DeviceRecord) {
  const data = {
    externalId: r.externalId ?? null, os: r.os ?? null, osVersion: r.osVersion ?? null, lastSeen: r.lastSeen ?? null, currentUser: r.currentUser ?? null,
    patchStatus: r.patchStatus ?? null, lastPatched: r.lastPatched ?? null, applications: (r.applications ?? []) as Prisma.InputJsonValue, sourceTimestamp: r.timestamp ?? new Date(),
  };
  const cur = await t.assetSourceData.findUnique({ where: { assetId_sourceKey: { assetId, sourceKey: source.key } } });
  if (cur) {
    const same = (['externalId', 'os', 'osVersion', 'currentUser', 'patchStatus'] as const).every((k) => cur[k] === data[k])
      && asText(cur.lastSeen) === asText(data.lastSeen) && asText(cur.lastPatched) === asText(data.lastPatched)
      && JSON.stringify(cur.applications) === JSON.stringify(data.applications);
    if (same) return false;
    await t.assetSourceData.update({ where: { id: cur.id }, data });
    return true;
  }
  await t.assetSourceData.create({ data: { assetId, sourceKey: source.key, ...data } });
  return true;
}

async function applyExpiries(t: Db, source: IntegrationSource, asset: Pick<Asset, 'id' | 'assetCode'>, r: DeviceRecord) {
  let changed = false;
  for (const e of r.expiries ?? []) {
    const d = new Date(e.expiry);
    if (isNaN(d.getTime())) throw badRequest(`Invalid expiry date "${e.expiry}" for ${e.label}`);
    const res = await upsertExpiryFromSource(t, asset, { type: e.type as RenewableType, label: e.label, expiry: dateOnly(d.toISOString().slice(0, 10)), identifier: e.identifier, vendor: e.vendor }, source.key);
    if (res !== 'unchanged') changed = true;
  }
  return changed;
}

async function autoCreate(t: Prisma.TransactionClient, source: IntegrationSource, r: DeviceRecord) {
  if (!source.autoCreateCategoryId || !source.autoCreateLocationId) throw new Error('Auto-create is on but no default category/location is configured.');
  const input = createAssetInput.parse({
    categoryId: source.autoCreateCategoryId, locationId: source.autoCreateLocationId, make: r.make || 'Unknown', model: r.model || 'Unknown',
    serialNumber: r.serialNumber, hostname: r.hostname, ipAddress: r.ipAddress, macAddress: r.macAddress, legacyTag: r.legacyTag,
    warrantyEnd: r.warrantyEnd ? r.warrantyEnd.toISOString().slice(0, 10) : null,
    remarks: `Auto-created from ${source.name}${r.externalId ? ` (external ID ${r.externalId})` : ''}`,
  });
  const hits = await findDuplicates(t, input);
  const block = hits.find((h) => h.severity === 'BLOCK');
  if (block) throw new Error(`Duplicate ${block.key} ${block.value} on ${block.match.assetCode}`);
  const cat = await t.assetCategory.findUnique({ where: { id: input.categoryId } });
  if (cat?.serialRequired && !input.serialNumber) throw new Error(`Category ${cat.name} requires a serial number`);
  const warns = hits.filter((h) => h.severity === 'WARN');
  return insertAsset(t, integrationActor(source), { ...input, duplicateReason: warns.length ? `Auto-created by ${source.name}` : null }, `integration:${source.key}`, warns);
}

async function queueUnmatched(t: Db, source: IntegrationSource, r: DeviceRecord, runId: string) {
  const externalId = r.externalId ?? (r.serialNumber ? `serial:${r.serialNumber}` : r.hostname ? `host:${r.hostname}` : null);
  const payload = JSON.parse(JSON.stringify(r)) as Prisma.InputJsonValue;
  if (externalId) {
    await t.integrationUnmatched.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId } },
      create: { sourceId: source.id, externalId, serialNumber: r.serialNumber ?? null, hostname: r.hostname ?? null, payload, runId },
      update: { serialNumber: r.serialNumber ?? null, hostname: r.hostname ?? null, payload, runId, lastSeenAt: new Date() },
    });
  } else {
    await t.integrationUnmatched.create({ data: { sourceId: source.id, payload, runId } });
  }
}

async function queueConflict(t: Db, source: Pick<IntegrationSource, 'id'>, c: { entityType: string; entityId: string; entityLabel: string; field: string; currentValue: string | null; incomingValue: string | null; runId?: string | null }) {
  const open = await t.integrationConflict.findFirst({ where: { sourceId: source.id, entityType: c.entityType, entityId: c.entityId, field: c.field, status: 'OPEN' } });
  if (open) {
    await t.integrationConflict.update({ where: { id: open.id }, data: { currentValue: c.currentValue, incomingValue: c.incomingValue, runId: c.runId ?? open.runId } });
    return open.id;
  }
  const row = await t.integrationConflict.create({ data: { sourceId: source.id, ...c, runId: c.runId ?? null } });
  return row.id;
}

/**
 * FR-INT-08: a manual edit to a field last written by a source queues a conflict for
 * IT unless that source's rule for the field is "overwrite" (the next sync wins then)
 * or "ignore" (the source no longer owns it).
 */
export async function onManualAssetEdit(t: Db, asset: Pick<Asset, 'id' | 'assetCode' | 'fieldSources'>, before: Record<string, unknown>, after: Record<string, unknown>) {
  const fs = asset.fieldSources as Record<string, string>;
  for (const f of SYNCABLE_FIELDS) {
    if (!(f in after)) continue;
    const owner = fs[f];
    if (!owner || owner === 'manual' || owner === 'import') continue;
    const src = await t.integrationSource.findUnique({ where: { key: owner.replace(/^integration:/, '') }, include: { mappings: { where: { field: f } } } });
    if (!src) continue;
    const rule = src.mappings[0]?.rule ?? 'WARN';
    if (rule !== 'WARN') continue;
    await queueConflict(t, src, { entityType: 'ASSET', entityId: asset.id, entityLabel: asset.assetCode, field: f, currentValue: asText(after[f]), incomingValue: asText(before[f]) });
  }
}

// ───────────── Conflicts & unmatched queue ─────────────

export async function listConflicts(actor: Actor, p: { status?: string; sourceId?: string; skip: number; take: number }) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const where: Prisma.IntegrationConflictWhereInput = { status: (p.status as 'OPEN') || 'OPEN', ...(p.sourceId ? { sourceId: p.sourceId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.integrationConflict.findMany({ where, include: { source: { select: { name: true, key: true } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    prisma.integrationConflict.count({ where }),
  ]);
  return { rows, total };
}

export async function resolveConflict(actor: Actor, id: string, decision: 'ACCEPT_INCOMING' | 'KEEP_CURRENT') {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  return tx(async (t) => {
    const c = await t.integrationConflict.findUnique({ where: { id }, include: { source: true } });
    if (!c) throw notFound('Conflict');
    if (c.status !== 'OPEN') throw conflict('This conflict has already been resolved.');
    if (decision === 'ACCEPT_INCOMING') {
      if (c.entityType === 'ASSET') {
        const a = await t.asset.findUnique({ where: { id: c.entityId } });
        if (!a) throw notFound('Asset');
        if (a.status === 'RETIRED') throw conflict(`Asset ${a.assetCode} is retired.`);
        const v = c.field === 'warrantyEnd' ? (c.incomingValue ? dateOnly(c.incomingValue) : null) : c.incomingValue;
        const fs = { ...(a.fieldSources as Record<string, string>), [c.field]: c.source.key };
        const updated = await t.asset.update({ where: { id: a.id }, data: { [c.field]: v, fieldSources: fs, updatedById: actor.id } });
        await audit(t, actor, { action: 'ASSET_UPDATED', entityType: 'Asset', entityId: a.id, entityLabel: a.assetCode, before: { [c.field]: a[c.field as keyof Asset] }, after: { [c.field]: v }, details: { via: 'integration conflict', source: c.source.key, conflictId: c.id }, locationIds: a.locationId ? [a.locationId] : [] });
        if (c.field === 'warrantyEnd') await syncWarrantyRenewable(t, actor, updated, c.source.key);
      } else {
        const e = await t.employee.findUnique({ where: { id: c.entityId } });
        if (!e) throw notFound('Employee');
        const v = c.field === 'active' ? c.incomingValue === 'true' : c.incomingValue;
        const fs = { ...(e.fieldSources as Record<string, string>), [c.field]: 'AD' };
        await t.employee.update({ where: { id: e.id }, data: { [c.field]: v, fieldSources: fs } });
        await audit(t, actor, { action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: e.id, entityLabel: e.employeeCode, before: { [c.field]: e[c.field as keyof typeof e] }, after: { [c.field]: v }, details: { via: 'directory conflict', conflictId: c.id }, locationIds: e.locationId ? [e.locationId] : [] });
      }
    }
    await t.integrationConflict.update({ where: { id }, data: { status: decision === 'ACCEPT_INCOMING' ? 'ACCEPTED_INCOMING' : 'KEPT_CURRENT', resolvedAt: new Date(), resolvedById: actor.id } });
    await audit(t, actor, { action: 'INTEGRATION_CONFLICT_RESOLVED', entityType: 'IntegrationConflict', entityId: id, entityLabel: `${c.entityLabel}.${c.field}`, details: { decision, current: c.currentValue, incoming: c.incomingValue, source: c.source.key } });
  });
}

export async function listUnmatched(actor: Actor, p: { status?: string; sourceId?: string; skip: number; take: number }) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const where: Prisma.IntegrationUnmatchedWhereInput = { status: (p.status as 'OPEN') || 'OPEN', ...(p.sourceId ? { sourceId: p.sourceId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.integrationUnmatched.findMany({ where, include: { source: { select: { name: true, key: true } } }, orderBy: { lastSeenAt: 'desc' }, skip: p.skip, take: p.take }),
    prisma.integrationUnmatched.count({ where }),
  ]);
  return { rows, total };
}

export const unmatchedAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('LINK'), assetId: z.string().min(1) }),
  z.object({ action: z.literal('CREATE'), categoryId: z.string().min(1), locationId: z.string().min(1), make: z.string().trim().min(1).max(120), model: z.string().trim().min(1).max(160) }),
  z.object({ action: z.literal('DISMISS'), reason: z.string().trim().min(1, 'A reason is required').max(500) }),
]);

/** Resolve an unmatched record: link it to an existing asset, create one, or dismiss it (FR-INT-05). */
export async function resolveUnmatched(actor: Actor, id: string, input: unknown) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const d = unmatchedAction.parse(input);
  return tx(async (t) => {
    const u = await t.integrationUnmatched.findUnique({ where: { id }, include: { source: true } });
    if (!u) throw notFound('Unmatched record');
    if (u.status !== 'OPEN') throw conflict('This record has already been handled.');
    const rec = deviceRecord.parse(u.payload);
    let assetId: string | null = null;
    if (d.action === 'LINK') {
      const a = await t.asset.findUnique({ where: { id: d.assetId } });
      if (!a) throw notFound('Asset');
      if (a.status === 'RETIRED') throw conflict(`Asset ${a.assetCode} is retired.`);
      if (rec.serialNumber && a.serialNumber && a.serialNumber.toLowerCase() !== rec.serialNumber.toLowerCase()) throw conflict(`Asset ${a.assetCode} has serial ${a.serialNumber}, which differs from the record's ${rec.serialNumber}.`);
      if (rec.serialNumber && !a.serialNumber) await t.asset.update({ where: { id: a.id }, data: { serialNumber: rec.serialNumber, fieldSources: { ...(a.fieldSources as Record<string, string>), serialNumber: u.source.key }, updatedById: actor.id } });
      const rules = new Map((await t.integrationMapping.findMany({ where: { sourceId: u.sourceId } })).map((m) => [m.field, m.rule]));
      await upsertSourceData(t, u.source, a.id, rec);
      await applyExpiries(t, u.source, a, rec);
      for (const f of SYNCABLE_FIELDS) {
        const v = rec[f];
        if (v === null || v === undefined || v === '') continue;
        const cur = a[f as keyof Asset];
        const inVal = f === 'warrantyEnd' ? dateOnly((v as Date).toISOString().slice(0, 10)) : v;
        if (asText(cur) === asText(inVal)) continue;
        if ((rules.get(f) ?? 'WARN') === 'IGNORE') continue;
        if (cur === null || rules.get(f) === 'OVERWRITE') await t.asset.update({ where: { id: a.id }, data: { [f]: inVal } });
        else await queueConflict(t, u.source, { entityType: 'ASSET', entityId: a.id, entityLabel: a.assetCode, field: f, currentValue: asText(cur), incomingValue: asText(inVal) });
      }
      assetId = a.id;
    } else if (d.action === 'CREATE') {
      const input = createAssetInput.parse({ categoryId: d.categoryId, locationId: d.locationId, make: d.make, model: d.model, serialNumber: rec.serialNumber, hostname: rec.hostname, ipAddress: rec.ipAddress, macAddress: rec.macAddress, legacyTag: rec.legacyTag, warrantyEnd: rec.warrantyEnd ? rec.warrantyEnd.toISOString().slice(0, 10) : null });
      const hits = await findDuplicates(t, input);
      const block = hits.find((h) => h.severity === 'BLOCK');
      if (block) throw new AppError(409, 'DUPLICATE_BLOCKED', `Duplicate ${block.key} ${block.value} on ${block.match.assetCode}. Link the record to that asset instead.`);
      const cat = await t.assetCategory.findUnique({ where: { id: input.categoryId } });
      if (cat?.serialRequired && !input.serialNumber) throw badRequest(`Category ${cat.name} requires a serial number.`);
      const a = await insertAsset(t, actor, { ...input, duplicateReason: hits.length ? `Created from ${u.source.name} unmatched queue` : null }, `integration:${u.source.key}`, hits);
      await upsertSourceData(t, u.source, a.id, rec);
      await applyExpiries(t, u.source, a, rec);
      assetId = a.id;
    }
    await t.integrationUnmatched.update({ where: { id }, data: { status: d.action === 'LINK' ? 'LINKED' : d.action === 'CREATE' ? 'CREATED' : 'DISMISSED', resolvedAt: new Date(), resolvedById: actor.id, assetId } });
    await audit(t, actor, { action: 'INTEGRATION_UNMATCHED_' + d.action, entityType: 'IntegrationUnmatched', entityId: id, entityLabel: rec.serialNumber ?? rec.hostname ?? u.externalId, details: { source: u.source.key, assetId, ...(d.action === 'DISMISS' ? { reason: d.reason } : {}) } });
    return { assetId };
  });
}

// ───────────── Runs, health, retry, acknowledge (FR-INT-11) ─────────────

export async function listRuns(actor: Actor, p: { sourceId?: string; status?: string; skip: number; take: number }) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const where: Prisma.IntegrationRunWhereInput = { ...(p.sourceId ? { sourceId: p.sourceId } : {}), ...(p.status ? { status: p.status as 'FAILED' } : {}) };
  const [rows, total] = await Promise.all([
    prisma.integrationRun.findMany({ where, omit: { payload: true }, include: { source: { select: { name: true, key: true } } }, orderBy: { startedAt: 'desc' }, skip: p.skip, take: p.take }),
    prisma.integrationRun.count({ where }),
  ]);
  return { rows, total };
}

export async function getRun(actor: Actor, id: string) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const r = await prisma.integrationRun.findUnique({ where: { id }, omit: { payload: true }, include: { source: { select: { id: true, name: true, key: true } } } });
  if (!r) throw notFound('Run');
  return r;
}

export async function integrationHealth(actor: Actor) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const sources = await prisma.integrationSource.findMany({ orderBy: { name: 'asc' } });
  const [unmatched, conflicts] = await Promise.all([
    prisma.integrationUnmatched.groupBy({ by: ['sourceId'], where: { status: 'OPEN' }, _count: true }),
    prisma.integrationConflict.groupBy({ by: ['sourceId'], where: { status: 'OPEN' }, _count: true }),
  ]);
  const out = [];
  for (const s of sources) {
    const last = await prisma.integrationRun.findFirst({ where: { sourceId: s.id, status: { not: 'DUPLICATE' } }, orderBy: { startedAt: 'desc' }, omit: { payload: true } });
    const lastSuccess = await prisma.integrationRun.findFirst({ where: { sourceId: s.id, status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { startedAt: 'desc' }, omit: { payload: true } });
    const failing = await prisma.integrationRun.findMany({ where: { sourceId: s.id, status: { in: ['FAILED', 'PARTIAL'] }, acknowledgedAt: null }, orderBy: { startedAt: 'desc' }, take: 20, omit: { payload: true } });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const agg = await prisma.integrationRun.aggregate({ where: { sourceId: s.id, startedAt: { gte: since } }, _sum: { received: true, created: true, updated: true, conflicts: true, rejected: true, unmatched: true } });
    out.push({
      id: s.id, key: s.key, name: s.name, kind: s.kind, active: s.active, pullEnabled: s.pullEnabled,
      credential: s.kind === 'DEVICE' ? (s.apiKeyHash && !s.apiKeyRevokedAt ? `Active (itam_${s.apiKeyPrefix}_…)` : s.apiKeyRevokedAt ? 'Revoked' : 'Not issued') : null,
      lastRunAt: last?.startedAt ?? null, lastRunStatus: last?.status ?? null, lastSuccessAt: lastSuccess?.finishedAt ?? s.lastSuccessAt,
      lastRun: last ? countsOf(last) : null,
      last30Days: { received: agg._sum.received ?? 0, created: agg._sum.created ?? 0, updated: agg._sum.updated ?? 0, conflicts: agg._sum.conflicts ?? 0, rejected: agg._sum.rejected ?? 0, unmatched: agg._sum.unmatched ?? 0 },
      unmatchedOpen: unmatched.find((u) => u.sourceId === s.id)?._count ?? 0,
      conflictsOpen: conflicts.find((u) => u.sourceId === s.id)?._count ?? 0,
      unacknowledgedErrors: failing.map((f) => ({ runId: f.id, at: f.startedAt, status: f.status, rejected: f.rejected, errors: (f.errors as unknown as RunNote[]).filter((e) => e.level === 'error').slice(0, 5) })),
    });
  }
  return out;
}

export async function acknowledgeRun(actor: Actor, runId: string) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const r = await prisma.integrationRun.findUnique({ where: { id: runId } });
  if (!r) throw notFound('Run');
  if (r.acknowledgedAt) return r;
  const u = await prisma.integrationRun.update({ where: { id: runId }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id }, omit: { payload: true } });
  await audit(prisma, actor, { action: 'INTEGRATION_RUN_ACKNOWLEDGED', entityType: 'IntegrationRun', entityId: runId, details: { status: r.status } });
  return u;
}

/** Re-process the stored payload of a failed or partial run. Idempotent: already-applied rows come back unchanged. */
export async function retryRun(actor: Actor, runId: string) {
  requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const r = await prisma.integrationRun.findUnique({ where: { id: runId }, include: { source: true } });
  if (!r) throw notFound('Run');
  if (r.status !== 'FAILED' && r.status !== 'PARTIAL') throw conflict('Only failed or partial runs can be retried.');
  if (r.source.kind === 'DIRECTORY') {
    await audit(prisma, actor, { action: 'INTEGRATION_RUN_RETRY', entityType: 'IntegrationRun', entityId: runId });
    const res = await runDirectorySync(actor, r.sourceId);
    await prisma.integrationRun.update({ where: { id: runId }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id } });
    return res;
  }
  if (!r.payload) throw conflict('This run has no stored payload to retry.');
  await audit(prisma, actor, { action: 'INTEGRATION_RUN_RETRY', entityType: 'IntegrationRun', entityId: runId });
  const res = await processBatch(r.source, r.payload, { mode: 'RETRY', retryOfRunId: r.id });
  await prisma.integrationRun.update({ where: { id: runId }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id } });
  return res;
}

// ───────────── Pull connector (FR-INT-04) ─────────────

export type PullFetcher = (url: string, init: { headers: Record<string, string> }) => Promise<unknown>;
const defaultFetcher: PullFetcher = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Source responded ${res.status} ${res.statusText}`);
  return res.json();
};

export async function runPull(actor: Actor, sourceId: string, fetcher: PullFetcher = defaultFetcher) {
  if (actor.id !== 'system') requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const s = await prisma.integrationSource.findUnique({ where: { id: sourceId } });
  if (!s) throw notFound('Integration source');
  if (s.kind !== 'DEVICE') throw badRequest('Pull applies to device sources.');
  const cfg = s.config as { url?: string; recordsPath?: string; authHeader?: string; authScheme?: string };
  if (!cfg.url || !/^https?:\/\//i.test(cfg.url)) throw badRequest('Configure the connector URL first.');
  const secret = decryptSecret(s.secretEnc);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (secret) headers[cfg.authHeader || 'authorization'] = cfg.authHeader && cfg.authHeader.toLowerCase() !== 'authorization' ? secret : `${cfg.authScheme || 'Bearer'} ${secret}`;
  if (actor.id !== 'system') await audit(prisma, actor, { action: 'INTEGRATION_PULL_REQUESTED', entityType: 'IntegrationSource', entityId: s.id, entityLabel: s.name });
  let body: unknown;
  try {
    body = await fetcher(cfg.url, { headers });
  } catch (e) {
    const run = await prisma.integrationRun.create({ data: { sourceId: s.id, mode: 'PULL', status: 'FAILED', finishedAt: new Date(), errors: [{ record: 0, level: 'error', message: `Fetch failed: ${(e as Error).message}` }] } });
    await prisma.integrationSource.update({ where: { id: s.id }, data: { lastRunAt: new Date() } });
    return { runId: run.id, status: 'FAILED' as const, counts: countsOf(run) };
  }
  const records = (cfg.recordsPath ? cfg.recordsPath.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], body) : body) as unknown;
  if (!Array.isArray(records)) {
    const run = await prisma.integrationRun.create({ data: { sourceId: s.id, mode: 'PULL', status: 'FAILED', finishedAt: new Date(), errors: [{ record: 0, level: 'error', message: `No record array found at "${cfg.recordsPath || '(root)'}"` }] } });
    return { runId: run.id, status: 'FAILED' as const, counts: countsOf(run) };
  }
  if (!records.length) {
    const run = await prisma.integrationRun.create({ data: { sourceId: s.id, mode: 'PULL', status: 'SUCCESS', finishedAt: new Date() } });
    await prisma.integrationSource.update({ where: { id: s.id }, data: { lastRunAt: new Date(), lastSuccessAt: new Date() } });
    return { runId: run.id, status: 'SUCCESS' as const, counts: countsOf(run) };
  }
  return processBatch(s, { records }, { mode: 'PULL' });
}

// ───────────── Active Directory sync (FR-INT-01, FR-EMP-04) ─────────────

export interface DirectoryEntry { dn: string; employeeCode: string | null; name: string | null; email: string | null; department: string | null; managerDn: string | null; active: boolean }
export type DirectoryFetcher = (cfg: DirectoryConfig, password: string | null) => Promise<DirectoryEntry[]>;
export interface DirectoryConfig { url: string; bindDN?: string; baseDN: string; filter?: string; attributes?: Partial<Record<'employeeCode' | 'name' | 'email' | 'department' | 'manager', string>>; tlsRejectUnauthorized?: boolean }

const ldapFetcher: DirectoryFetcher = async (cfg, password) => {
  const { Client } = await import('ldapts');
  const a = { employeeCode: 'employeeID', name: 'displayName', email: 'mail', department: 'department', manager: 'manager', ...(cfg.attributes ?? {}) };
  const client = new Client({ url: cfg.url, timeout: 30_000, connectTimeout: 15_000, tlsOptions: cfg.url.startsWith('ldaps') ? { rejectUnauthorized: cfg.tlsRejectUnauthorized !== false } : undefined });
  try {
    if (cfg.bindDN) await client.bind(cfg.bindDN, password ?? '');
    const { searchEntries } = await client.search(cfg.baseDN, {
      scope: 'sub', filter: cfg.filter || '(&(objectCategory=person)(objectClass=user))',
      attributes: ['dn', a.employeeCode, a.name, a.email, a.department, a.manager, 'userAccountControl'], paged: { pageSize: 500 },
    });
    const str = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
    return searchEntries.map((e) => {
      const uac = Number(str(e.userAccountControl) ?? 0);
      return { dn: e.dn, employeeCode: str(e[a.employeeCode])?.toString().trim() || null, name: str(e[a.name])?.toString().trim() || null, email: str(e[a.email])?.toString().trim().toLowerCase() || null, department: str(e[a.department])?.toString().trim() || null, managerDn: str(e[a.manager])?.toString() || null, active: (uac & 2) === 0 };
    });
  } finally {
    await client.unbind().catch(() => undefined);
  }
};

export async function runDirectorySync(actor: Actor, sourceId: string, fetcher: DirectoryFetcher = ldapFetcher) {
  if (actor.id !== 'system') requireRole(actor, 'ADMIN', 'IT_OPERATOR');
  const s = await prisma.integrationSource.findUnique({ where: { id: sourceId }, include: { mappings: true } });
  if (!s) throw notFound('Integration source');
  if (s.kind !== 'DIRECTORY') throw badRequest('This source is not a directory source.');
  const cfg = s.config as unknown as DirectoryConfig;
  if (!cfg.url || !cfg.baseDN) throw badRequest('Configure the directory URL and base DN first.');
  const run = await prisma.integrationRun.create({ data: { sourceId: s.id, mode: actor.id === 'system' ? 'SCHEDULED' : 'ON_DEMAND' } });
  if (actor.id !== 'system') await audit(prisma, actor, { action: 'DIRECTORY_SYNC_REQUESTED', entityType: 'IntegrationSource', entityId: s.id, entityLabel: s.name });
  let entries: DirectoryEntry[];
  try {
    entries = await fetcher(cfg, decryptSecret(s.secretEnc));
  } catch (e) {
    const failed = await prisma.integrationRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), errors: [{ record: 0, level: 'error', message: `Directory query failed: ${(e as Error).message}` }] } });
    await prisma.integrationSource.update({ where: { id: s.id }, data: { lastRunAt: new Date() } });
    await notifyUsers(prisma, await adminUserIds(prisma), { type: 'INTEGRATION_FAILURE', title: `${s.name}: directory sync failed`, body: (e as Error).message, link: `/integrations/sources/${s.id}`, eventKey: `integration-run:${run.id}:admin` });
    return { runId: failed.id, status: 'FAILED' as const };
  }
  const rules = new Map<string, FieldRule>(s.mappings.map((m) => [m.field, m.rule]));
  const notes: RunNote[] = [];
  const report = { created: [] as string[], updated: [] as string[], deactivated: [] as string[], conflicts: [] as string[], holdingAssets: [] as string[] };
  const counts: RunCounts = { received: entries.length, created: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, unmatched: 0 };
  const valid = entries.filter((e, i) => {
    if (!e.employeeCode || !e.name) { counts.rejected++; notes.push({ record: i + 1, externalId: e.dn, level: 'error', message: 'Missing employee ID or name' }); return false; }
    return true;
  });
  const seen = new Set<string>();
  const byCode = new Map<string, DirectoryEntry>();
  for (const e of valid) {
    const code = e.employeeCode!.toUpperCase();
    if (seen.has(code)) { counts.rejected++; notes.push({ record: 0, externalId: e.dn, level: 'error', message: `Duplicate employee ID ${code} in directory` }); continue; }
    seen.add(code);
    byCode.set(code, e);
  }
  const dnToCode = new Map([...byCode.values()].map((e) => [e.dn.toLowerCase(), e.employeeCode!.toUpperCase()]));
  const sysActor: Actor = actor.id === 'system' ? { ...SYSTEM_ACTOR, name: `Directory: ${s.name}` } : actor;

  // Pass 1: create/update people (managers resolved in pass 2).
  for (const [code, e] of byCode) {
    try {
      await tx(async (t) => {
        const dept = e.department ? (await t.department.findFirst({ where: { name: { equals: e.department, mode: 'insensitive' } } })) ?? (await t.department.create({ data: { name: e.department } })) : null;
        const existing = await t.employee.findFirst({ where: { employeeCode: { equals: code, mode: 'insensitive' } } });
        const incoming: Record<string, unknown> = { name: e.name, email: e.email, departmentId: dept?.id ?? null, active: e.active };
        if (!existing) {
          const created = await t.employee.create({ data: { employeeCode: code, name: e.name!, email: e.email, departmentId: dept?.id ?? null, active: e.active, source: 'AD', externalId: e.dn, fieldSources: Object.fromEntries(DIRECTORY_FIELDS.map((f) => [f, 'AD'])) } });
          await audit(t, sysActor, { action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: created.id, entityLabel: code, after: incoming, details: { source: s.key, runId: run.id } });
          counts.created++; report.created.push(code);
          return;
        }
        const r = await applyEmployeeFields(t, s, existing, incoming, rules, run.id, sysActor);
        if (r.conflicts) { counts.conflicts += r.conflicts; report.conflicts.push(code); }
        if (r.changed.length) { counts.updated++; report.updated.push(`${code}: ${r.changed.join(', ')}`); } else counts.unchanged++;
        if (r.deactivated) { report.deactivated.push(code); if (r.holding) report.holdingAssets.push(`${code} (${r.holding})`); }
        if (existing.externalId !== e.dn || existing.source !== 'AD') await t.employee.update({ where: { id: existing.id }, data: { externalId: e.dn, source: existing.source === 'MANUAL' || existing.source === 'IMPORT' ? 'AD' : existing.source } });
      });
    } catch (err) {
      counts.rejected++; notes.push({ record: 0, externalId: e.dn, level: 'error', message: `${code}: ${(err as Error).message}` });
    }
  }
  // Pass 2: manager links.
  for (const [code, e] of byCode) {
    const mgrCode = e.managerDn ? dnToCode.get(e.managerDn.toLowerCase()) : null;
    try {
      await tx(async (t) => {
        const emp = await t.employee.findUnique({ where: { employeeCode: code } });
        if (!emp) return;
        const mgr = mgrCode ? await t.employee.findUnique({ where: { employeeCode: mgrCode }, select: { id: true, managerId: true } }) : null;
        if (e.managerDn && !mgr) notes.push({ record: 0, externalId: e.dn, level: 'info', message: `${code}: manager ${e.managerDn} not found in the synced set` });
        const newMgr = mgr?.id ?? null;
        if (newMgr === emp.managerId) return;
        if (newMgr && (await createsCycle(t, emp.id, newMgr))) { notes.push({ record: 0, level: 'error', message: `${code}: manager link would create a cycle; skipped` }); counts.rejected++; return; }
        const r = await applyEmployeeFields(t, s, emp, { managerId: newMgr }, rules, run.id, sysActor);
        if (r.conflicts) { counts.conflicts += r.conflicts; report.conflicts.push(code); }
        if (r.changed.length && !report.created.includes(code) && !report.updated.some((u) => u.startsWith(`${code}:`))) { counts.updated++; counts.unchanged = Math.max(0, counts.unchanged - 1); report.updated.push(`${code}: managerId`); }
      });
    } catch (err) {
      counts.rejected++; notes.push({ record: 0, level: 'error', message: `${code}: ${(err as Error).message}` });
    }
  }
  // Removed from the directory → inactive; nothing is deleted (FR-INT-01). Guarded against an empty result.
  if (byCode.size > 0) {
    const gone = await prisma.employee.findMany({ where: { source: 'AD', active: true, employeeCode: { notIn: [...byCode.keys()] } } });
    for (const g of gone) {
      await tx(async (t) => {
        const r = await applyEmployeeFields(t, s, g, { active: false }, rules, run.id, sysActor);
        if (r.conflicts) { counts.conflicts += r.conflicts; report.conflicts.push(g.employeeCode); }
        if (r.deactivated) { counts.updated++; report.deactivated.push(g.employeeCode); if (r.holding) report.holdingAssets.push(`${g.employeeCode} (${r.holding})`); }
      });
    }
  } else {
    notes.push({ record: 0, level: 'error', message: 'The directory returned no people; no one was deactivated.' });
  }
  const errors = notes.filter((n) => n.level === 'error').length;
  const status = errors === 0 ? 'SUCCESS' : counts.created + counts.updated + counts.unchanged > 0 ? 'PARTIAL' : 'FAILED';
  await prisma.integrationRun.update({ where: { id: run.id }, data: { ...counts, status, finishedAt: new Date(), errors: notes.slice(0, 1000) as unknown as Prisma.InputJsonValue, payload: report as unknown as Prisma.InputJsonValue } });
  await prisma.integrationSource.update({ where: { id: s.id }, data: { lastRunAt: new Date(), ...(status !== 'FAILED' ? { lastSuccessAt: new Date() } : {}) } });
  await audit(prisma, sysActor, { action: 'DIRECTORY_SYNC', entityType: 'IntegrationRun', entityId: run.id, entityLabel: s.name, details: { ...counts, status, deactivated: report.deactivated.length } });
  if (status !== 'SUCCESS') await notifyRunOutcome(s, run.id, status, { ...counts, unmatched: 0 });
  else if (counts.conflicts) await notifyRunOutcome(s, run.id, status, counts);
  if (report.holdingAssets.length) {
    await notifyUsers(prisma, await itUserIds(prisma), {
      type: 'INTEGRATION', title: `${s.name}: offboarding needed for ${report.holdingAssets.length} employee(s)`,
      body: `Marked inactive by the directory while still holding assets: ${report.holdingAssets.slice(0, 10).join(', ')}. Use the offboarding view to check in or reassign.`,
      link: '/employees?active=false&holding=true', eventKey: `integration-run:${run.id}:offboarding`, email: true,
    });
  }
  return { runId: run.id, status, counts: countsOf(counts), report };
}

async function createsCycle(t: Db, employeeId: string, managerId: string) {
  let cur: string | null = managerId;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === employeeId) return true;
    cur = (await t.employee.findUnique({ where: { id: cur }, select: { managerId: true } }))?.managerId ?? null;
  }
  return false;
}

async function applyEmployeeFields(t: Prisma.TransactionClient, s: IntegrationSource, e: { id: string; employeeCode: string; fieldSources: Prisma.JsonValue; locationId: string | null } & Record<string, unknown>, incoming: Record<string, unknown>, rules: Map<string, FieldRule>, runId: string, actor: Actor) {
  const fs = { ...(e.fieldSources as Record<string, string>) };
  const changes: Record<string, unknown> = {};
  let conflicts = 0;
  for (const [f, v] of Object.entries(incoming)) {
    if (asText(e[f]) === asText(v)) { fs[f] = fs[f] ?? 'AD'; continue; }
    const rule = rules.get(f) ?? 'WARN';
    if (rule === 'IGNORE') continue;
    const owned = e[f] === null || e[f] === undefined || fs[f] === 'AD' || !fs[f];
    if (rule === 'OVERWRITE' || owned) { changes[f] = v; fs[f] = 'AD'; }
    else { await queueConflict(t, s, { entityType: 'EMPLOYEE', entityId: e.id, entityLabel: e.employeeCode, field: f, currentValue: asText(e[f]), incomingValue: asText(v), runId }); conflicts++; }
  }
  let holding = 0;
  const deactivated = changes.active === false;
  if (Object.keys(changes).length) {
    await t.employee.update({ where: { id: e.id }, data: { ...changes, fieldSources: fs } });
    await audit(t, actor, { action: deactivated ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: e.id, entityLabel: e.employeeCode, before: Object.fromEntries(Object.keys(changes).map((k) => [k, e[k]])), after: changes, details: { source: s.key, runId }, locationIds: e.locationId ? [e.locationId] : [] });
    // FR-EMP-03 applies: held assets are listed for offboarding; nothing is moved automatically.
    if (deactivated) holding = await t.asset.count({ where: { holderEmployeeId: e.id, status: { not: 'RETIRED' } } });
  }
  return { changed: Object.keys(changes), conflicts, deactivated, holding };
}

export async function scheduledIntegrations(now = new Date()) {
  const due = await prisma.integrationSource.findMany({ where: { active: true, pullEnabled: true, pullIntervalMinutes: { not: null } } });
  const results: { source: string; status: string }[] = [];
  for (const s of due) {
    if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < s.pullIntervalMinutes! * 60_000) continue;
    try {
      const r = s.kind === 'DIRECTORY' ? await runDirectorySync(SYSTEM_ACTOR, s.id) : await runPull(SYSTEM_ACTOR, s.id);
      results.push({ source: s.key, status: r.status });
    } catch (e) {
      results.push({ source: s.key, status: `error: ${(e as Error).message}` });
    }
  }
  return results;
}
