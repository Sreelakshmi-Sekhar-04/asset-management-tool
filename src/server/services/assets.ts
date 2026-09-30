import { isIP } from 'node:net';
import { z } from 'zod';
import type { Asset, Prisma } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { dateOnly, todayIST } from '@/lib/format';
import type { Actor } from '../actor';
import { audit, diff } from '../audit';
import { assetScope, getScopedAsset } from '../scope';
import { getSettings } from '../settings';
import { createApprovalRequest, findPolicy } from './approvals';
import { assertNotRetired, assertUnlocked, holderColumns, holderOf, recordMovement, switchAssignment, validateHolder, type HolderRef } from './movement';
import { syncWarrantyRenewable } from './renewables';

const optStr = (max = 200) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD').nullable().optional().or(z.literal('').transform(() => null));

export const assetFields = {
  categoryId: z.string().min(1, 'Category is required'),
  make: z.string().trim().min(1, 'Make is required').max(120),
  model: z.string().trim().min(1, 'Model is required').max(160),
  serialNumber: optStr(120),
  hostname: optStr(120),
  ipAddress: optStr(60).refine((v) => !v || isIP(v) !== 0, 'Enter a valid IPv4 or IPv6 address'),
  macAddress: optStr(40).refine((v) => !v || /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$|^[0-9A-Fa-f]{12}$/.test(v), 'Enter a valid MAC address'),
  legacyTag: optStr(80),
  purchaseDate: optDate,
  purchaseCost: z.union([z.number(), z.string()]).nullable().optional().transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (isNaN(n) || n < 0) { ctx.addIssue({ code: 'custom', message: 'Cost must be a non-negative number' }); return z.NEVER; }
    return n;
  }),
  vendor: optStr(160),
  warrantyEnd: optDate,
  condition: optStr(120),
  remarks: optStr(2000),
  sdpTicketId: optStr(60),
  sdpTicketUrl: optStr(500).refine((v) => !v || /^https?:\/\//i.test(v), 'Ticket URL must start with http(s)://'),
};

export const createAssetInput = z.object({ ...assetFields, locationId: z.string().min(1, 'Location is required'), duplicateReason: optStr(500) });
export type CreateAssetInput = z.input<typeof createAssetInput>;

const EDITABLE_ALL = ['categoryId', 'make', 'model', 'serialNumber', 'hostname', 'ipAddress', 'macAddress', 'legacyTag', 'purchaseDate', 'purchaseCost', 'vendor', 'warrantyEnd', 'condition', 'remarks', 'sdpTicketId', 'sdpTicketUrl'] as const;
const EDITABLE_BRANCH = ['hostname', 'ipAddress', 'macAddress', 'remarks'] as const;
const MOVEMENT_ONLY = ['status', 'locationId', 'holderType', 'holderEmployeeId', 'holderDepartmentId', 'holderLocationId', 'holder'];

// ───────────── Duplicate detection (FR-REG-05, FR-CFG-06) ─────────────

export interface DuplicateHit {
  key: 'serial' | 'legacyTag' | 'hostname' | 'ip';
  severity: 'BLOCK' | 'WARN';
  value: string;
  match: { id: string; assetCode: string; status: string; make: string; model: string; location: string | null };
}

export async function findDuplicates(db: Db, f: { serialNumber?: string | null; legacyTag?: string | null; hostname?: string | null; ipAddress?: string | null }, excludeId?: string): Promise<DuplicateHit[]> {
  const rules = (await getSettings(db)).duplicateRules;
  const hits: DuplicateHit[] = [];
  const not = excludeId ? { id: { not: excludeId } } : {};
  const sel = { id: true, assetCode: true, status: true, make: true, model: true, location: { select: { namePath: true } } } as const;
  const push = (key: DuplicateHit['key'], severity: DuplicateHit['severity'], value: string, rows: { id: string; assetCode: string; status: string; make: string; model: string; location: { namePath: string } | null }[]) => {
    for (const r of rows) hits.push({ key, severity, value, match: { id: r.id, assetCode: r.assetCode, status: r.status, make: r.make, model: r.model, location: r.location?.namePath ?? null } });
  };
  const serial = f.serialNumber?.trim();
  if (serial) push('serial', 'BLOCK', serial, await db.asset.findMany({ where: { serialNormalized: serial.toLowerCase(), ...not }, select: sel, take: 5 }));
  const tag = f.legacyTag?.trim();
  if (tag) push('legacyTag', 'BLOCK', tag, await db.asset.findMany({ where: { legacyTagNormalized: tag.toLowerCase(), ...not }, select: sel, take: 5 }));
  const host = f.hostname?.trim();
  if (host && rules.hostname !== 'OFF') push('hostname', rules.hostname, host, await db.asset.findMany({ where: { hostnameNormalized: host.toLowerCase(), status: { not: 'RETIRED' }, ...not }, select: sel, take: 5 }));
  const ip = f.ipAddress?.trim();
  if (ip && rules.ip !== 'OFF') push('ip', rules.ip, ip, await db.asset.findMany({ where: { ipAddress: ip, status: { not: 'RETIRED' }, ...not }, select: sel, take: 5 }));
  return hits;
}

const KEY_LABEL = { serial: 'serial number', legacyTag: 'legacy tag', hostname: 'hostname', ip: 'IP address' };

/** Throws on BLOCK; on WARN requires a reason. Returns warn hits to be flagged. */
export function enforceDuplicates(hits: DuplicateHit[], reason: string | null | undefined): DuplicateHit[] {
  const blocks = hits.filter((h) => h.severity === 'BLOCK');
  if (blocks.length) {
    const b = blocks[0];
    throw new AppError(409, 'DUPLICATE_BLOCKED',
      `An asset with ${KEY_LABEL[b.key]} "${b.value}" already exists: ${b.match.assetCode}${b.match.status === 'RETIRED' ? ' (a retired record)' : ''}. Save blocked.`,
      { matches: blocks });
  }
  const warns = hits.filter((h) => h.severity === 'WARN');
  if (warns.length && !reason?.trim()) {
    throw new AppError(409, 'DUPLICATE_WARNING',
      `Possible duplicate: ${warns.map((w) => `${KEY_LABEL[w.key]} "${w.value}" is used by ${w.match.assetCode}`).join('; ')}. Give a reason to continue.`,
      { matches: warns });
  }
  return warns;
}

async function flagDuplicates(db: Db, actor: Actor, assetId: string, warns: DuplicateHit[], reason: string) {
  if (!warns.length) return;
  await db.duplicateFlag.createMany({ data: warns.map((w) => ({ assetId, matchedAssetId: w.match.id, key: w.key, value: w.value, reason, createdById: actor.id === 'system' ? null : actor.id })) });
  await db.asset.updateMany({ where: { id: { in: [assetId, ...warns.map((w) => w.match.id)] } }, data: { flagDuplicateSuspect: true } });
}

// ───────────── Create (FR-REG-01) ─────────────

async function validateRefs(db: Db, data: { categoryId: string; serialNumber?: string | null; locationId?: string }, existingCategoryId?: string) {
  const cat = await db.assetCategory.findUnique({ where: { id: data.categoryId } });
  if (!cat) throw badRequest('Category not found.', [{ field: 'categoryId', message: 'Unknown category' }]);
  if (!cat.active && cat.id !== existingCategoryId) throw badRequest(`Category "${cat.name}" is inactive and cannot be used for new assets.`);
  if (cat.serialRequired && !data.serialNumber?.trim()) throw badRequest(`Serial number is required for category ${cat.name}.`, [{ field: 'serialNumber', message: `Required for ${cat.name}` }]);
  if (data.locationId) {
    const loc = await db.location.findUnique({ where: { id: data.locationId } });
    if (!loc || !loc.active) throw badRequest('Location not found or inactive.', [{ field: 'locationId', message: 'Unknown or inactive location' }]);
  }
  return cat;
}

export async function createAsset(actor: Actor, input: unknown, opts: { db?: Db; skipApproval?: boolean; origin?: string; approverName?: string } = {}) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users cannot create assets directly; add unlisted assets through a verification task.');
  const data = createAssetInput.parse(input);
  const run = async (t: Db) => {
    const cat = await validateRefs(t, data);
    const warns = enforceDuplicates(await findDuplicates(t, data), data.duplicateReason);
    if (!opts.skipApproval) {
      const policy = await findPolicy(t, 'ASSET_CREATE', { categoryIds: [cat.id], maxCost: data.purchaseCost ?? null, quantity: 1, interState: null, initiatorRole: actor.role });
      if (policy) {
        const req = await createApprovalRequest(t, actor, {
          action: 'ASSET_CREATE', policy, summary: `Create ${cat.name} ${data.make} ${data.model}${data.serialNumber ? ` (${data.serialNumber})` : ''}`,
          assetIds: [], locationIds: [data.locationId], payload: { assets: [data] } as unknown as Prisma.InputJsonValue,
        });
        return { pendingApproval: { id: req.id, requestNo: req.requestNo, policy: policy.name } };
      }
    }
    const asset = await insertAsset(t, actor, data, opts.origin ?? 'manual', warns, opts.approverName);
    return { asset };
  };
  return opts.db ? run(opts.db) : tx(run);
}

/** Low-level insert used by manual create, bulk add, approvals, verification and integrations. */
export async function insertAsset(t: Db, actor: Actor, data: z.infer<typeof createAssetInput>, origin: string, warns: DuplicateHit[], approverName?: string, extra: Partial<Prisma.AssetUncheckedCreateInput> = {}) {
  const src = origin === 'manual' ? 'manual' : origin;
  const fieldSources: Record<string, string> = {};
  for (const k of ['make', 'model', 'serialNumber', 'hostname', 'ipAddress', 'macAddress', 'warrantyEnd']) if ((data as Record<string, unknown>)[k]) fieldSources[k] = src;
  const asset = await t.asset.create({
    data: {
      categoryId: data.categoryId, make: data.make, model: data.model, serialNumber: data.serialNumber, hostname: data.hostname,
      ipAddress: data.ipAddress, macAddress: data.macAddress, legacyTag: data.legacyTag,
      purchaseDate: data.purchaseDate ? dateOnly(data.purchaseDate) : null, purchaseCost: data.purchaseCost ?? null, vendor: data.vendor,
      warrantyEnd: data.warrantyEnd ? dateOnly(data.warrantyEnd) : null, condition: data.condition, remarks: data.remarks,
      sdpTicketId: data.sdpTicketId, sdpTicketUrl: data.sdpTicketUrl, locationId: data.locationId, status: 'IN_STOCK',
      origin, fieldSources, createdById: actor.id === 'system' ? null : actor.id, updatedById: actor.id === 'system' ? null : actor.id,
      ...extra,
    },
  });
  await recordMovement(t, actor, origin === 'import' ? 'IMPORTED' : 'REGISTERED', null, { id: asset.id, status: asset.status, locationId: asset.locationId, holder: null }, { approverName, reason: origin !== 'manual' ? `Source: ${origin}` : null });
  if (warns.length) await flagDuplicates(t, actor, asset.id, warns, data.duplicateReason ?? 'Accepted duplicate');
  await audit(t, actor, { action: 'ASSET_CREATED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, after: { ...data, assetCode: asset.assetCode, origin }, details: warns.length ? { duplicateWarnings: warns.map((w) => ({ key: w.key, value: w.value, match: w.match.assetCode })), reason: data.duplicateReason } : approverName ? { approvedBy: approverName } : undefined, locationIds: [asset.locationId] });
  if (asset.warrantyEnd) await syncWarrantyRenewable(t, actor, asset);
  return asset;
}

// ───────────── Bulk add by model × quantity (FR-REG-08) ─────────────

export const bulkAddInput = z.object({
  categoryId: assetFields.categoryId, make: assetFields.make, model: assetFields.model, locationId: z.string().min(1),
  purchaseDate: assetFields.purchaseDate, purchaseCost: assetFields.purchaseCost, vendor: assetFields.vendor, warrantyEnd: assetFields.warrantyEnd,
  items: z.array(z.object({ serialNumber: optStr(120), hostname: optStr(120) })).min(1).max(500),
  duplicateReason: optStr(500),
});

export async function bulkAddAssets(actor: Actor, input: unknown, opts: { skipApproval?: boolean; db?: Db; approverName?: string } = {}) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  const data = bulkAddInput.parse(input);
  const run = async (t: Db) => {
    const cat = await validateRefs(t, { categoryId: data.categoryId, locationId: data.locationId });
    const problems: { line: number; message: string }[] = [];
    const seen = new Map<string, number>();
    const allWarns: DuplicateHit[][] = [];
    for (const [i, it] of data.items.entries()) {
      if (cat.serialRequired && !it.serialNumber) problems.push({ line: i + 1, message: `Serial number is required for category ${cat.name}.` });
      if (it.serialNumber) {
        const k = it.serialNumber.toLowerCase();
        if (seen.has(k)) problems.push({ line: i + 1, message: `Serial ${it.serialNumber} is repeated (also line ${seen.get(k)}).` });
        else seen.set(k, i + 1);
      }
      const hits = await findDuplicates(t, it);
      const blocks = hits.filter((h) => h.severity === 'BLOCK');
      for (const b of blocks) problems.push({ line: i + 1, message: `Serial ${b.value} already exists on ${b.match.assetCode}.` });
      const w = hits.filter((h) => h.severity === 'WARN');
      if (w.length && !data.duplicateReason) problems.push({ line: i + 1, message: `Possible duplicate ${w.map((x) => `${x.key} ${x.value} (${x.match.assetCode})`).join(', ')} — give a reason to continue.` });
      allWarns.push(w);
    }
    if (problems.length) throw badRequest(`${problems.length} line(s) cannot be saved. Nothing was created.`, problems);
    if (!opts.skipApproval) {
      const policy = await findPolicy(t, 'ASSET_CREATE', { categoryIds: [cat.id], maxCost: data.purchaseCost ?? null, quantity: data.items.length, interState: null, initiatorRole: actor.role });
      if (policy) {
        const req = await createApprovalRequest(t, actor, {
          action: 'ASSET_CREATE', policy, summary: `Bulk-create ${data.items.length} × ${cat.name} ${data.make} ${data.model}`,
          assetIds: [], locationIds: [data.locationId], payload: { bulk: data } as unknown as Prisma.InputJsonValue,
        });
        return { pendingApproval: { id: req.id, requestNo: req.requestNo, policy: policy.name } };
      }
    }
    const created: Asset[] = [];
    for (const [i, it] of data.items.entries()) {
      created.push(await insertAsset(t, actor, { ...data, ...it, macAddress: null, ipAddress: null, legacyTag: null, condition: null, remarks: null, sdpTicketId: null, sdpTicketUrl: null } as z.infer<typeof createAssetInput>, 'manual', allWarns[i], opts.approverName));
    }
    return { created: created.map((a) => ({ id: a.id, assetCode: a.assetCode, serialNumber: a.serialNumber })) };
  };
  return opts.db ? run(opts.db) : tx(run, { timeoutMs: 120_000 });
}

// ───────────── Edit (FR-REG-03, §A4.3.3) ─────────────

export const updateAssetInput = z.object({
  ...Object.fromEntries(Object.entries(assetFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  serialChangeReason: optStr(500),
  duplicateReason: optStr(500),
}).passthrough();

export async function updateAsset(actor: Actor, id: string, input: Record<string, unknown>) {
  if ('assetCode' in input || 'id' in input && input.id !== id) {
    await audit(prisma, actor, { action: 'ASSET_ID_CHANGE_REJECTED', entityType: 'Asset', entityId: id, details: { attempted: input.assetCode } });
    throw badRequest('The Asset ID is immutable and cannot be changed by any role.', [{ field: 'assetCode', message: 'Immutable' }]);
  }
  const blockedKeys = Object.keys(input).filter((k) => MOVEMENT_ONLY.includes(k));
  if (blockedKeys.length) throw badRequest(`${blockedKeys.join(', ')} cannot be edited directly. Use assign, check-in, repair, retire, transfer or (Administrators) "Correct location/holder".`);
  const allowed: readonly string[] = actor.role === 'BRANCH_USER' ? EDITABLE_BRANCH : EDITABLE_ALL;
  const provided = Object.keys(input).filter((k) => (EDITABLE_ALL as readonly string[]).includes(k));
  const denied = provided.filter((k) => !allowed.includes(k));
  if (denied.length) {
    await audit(prisma, actor, { action: 'ACCESS_DENIED', entityType: 'Asset', entityId: id, details: { attemptedFields: denied } });
    throw forbidden(`Your role cannot edit: ${denied.join(', ')}.`);
  }
  const data = updateAssetInput.parse(input) as Record<string, unknown>;
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, id, t);
    const changes: Record<string, unknown> = {};
    for (const k of provided) {
      let v = data[k];
      if ((k === 'purchaseDate' || k === 'warrantyEnd') && v) v = dateOnly(v as string);
      changes[k] = v ?? null;
    }
    const d = diff(asset as unknown as Record<string, unknown>, changes);
    if (!d.changed.length) return { asset, changed: [] };
    if (asset.status === 'RETIRED') {
      if (!(actor.role === 'ADMIN' && d.changed.every((k) => k === 'remarks'))) throw conflict(`Asset ${asset.assetCode} is retired. Only an Administrator may edit its remarks.`);
    }
    if (d.changed.includes('serialNumber')) {
      if (!data.serialChangeReason) throw badRequest('A reason is required to change the serial number.', [{ field: 'serialChangeReason', message: 'Required' }]);
    }
    if (d.changed.includes('categoryId') || d.changed.includes('serialNumber')) {
      await validateRefs(t, { categoryId: (changes.categoryId as string) ?? asset.categoryId, serialNumber: d.changed.includes('serialNumber') ? (changes.serialNumber as string) : asset.serialNumber }, asset.categoryId);
    }
    const dupCheck = {
      serialNumber: d.changed.includes('serialNumber') ? (changes.serialNumber as string) : null,
      legacyTag: d.changed.includes('legacyTag') ? (changes.legacyTag as string) : null,
      hostname: d.changed.includes('hostname') ? (changes.hostname as string) : null,
      ipAddress: d.changed.includes('ipAddress') ? (changes.ipAddress as string) : null,
    };
    const warns = enforceDuplicates(await findDuplicates(t, dupCheck, asset.id), data.duplicateReason as string);
    const fieldSources = { ...(asset.fieldSources as Record<string, string>) };
    for (const k of d.changed) fieldSources[k] = 'manual';
    const updated = await t.asset.update({ where: { id: asset.id }, data: { ...Object.fromEntries(d.changed.map((k) => [k, changes[k]])), fieldSources, updatedById: actor.id } });
    if (warns.length) await flagDuplicates(t, actor, asset.id, warns, data.duplicateReason as string);
    await audit(t, actor, {
      action: 'ASSET_UPDATED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: d.before, after: d.after,
      details: { fields: d.changed, ...(data.serialChangeReason ? { serialChangeReason: data.serialChangeReason } : {}), ...(warns.length ? { duplicateReason: data.duplicateReason } : {}) },
      locationIds: [asset.locationId],
    });
    if (d.changed.includes('warrantyEnd')) await syncWarrantyRenewable(t, actor, updated);
    return { asset: updated, changed: d.changed };
  });
}

// ───────────── Administrator correction (§A4.3.3) ─────────────

export const correctionInput = z.object({
  locationId: z.string().optional(),
  holder: z.object({ type: z.enum(['EMPLOYEE', 'DEPARTMENT', 'LOCATION']), id: z.string() }).nullable().optional(),
  reason: z.string().trim().min(3, 'A reason is mandatory for corrections'),
});

export async function correctLocationHolder(actor: Actor, id: string, input: unknown) {
  if (actor.role !== 'ADMIN') throw forbidden('Only an Administrator can correct location or holder.');
  const data = correctionInput.parse(input);
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, id, t);
    assertNotRetired(asset);
    await assertUnlocked(t, [asset]);
    const locationId = data.locationId ?? asset.locationId;
    if (data.locationId) {
      const loc = await t.location.findUnique({ where: { id: data.locationId } });
      if (!loc || !loc.active) throw badRequest('Location not found or inactive.');
    }
    let holder: HolderRef | null = data.holder === undefined ? holderOf(asset) : data.holder;
    if (holder) await validateHolder(t, actor, holder);
    let status = asset.status;
    if (holder && status === 'IN_STOCK') status = 'ASSIGNED';
    if (!holder && status === 'ASSIGNED') status = 'IN_STOCK';
    if (!holder && status === 'UNDER_REPAIR') holder = null;
    const updated = await t.asset.update({ where: { id: asset.id }, data: { locationId, status, ...holderColumns(holder), updatedById: actor.id } });
    const holderChanged = JSON.stringify(holderOf(asset)) !== JSON.stringify(holder);
    if (holderChanged) await switchAssignment(t, actor, asset.id, holder, 'CORRECTION');
    await recordMovement(t, actor, 'CORRECTION', asset, { id: asset.id, status, locationId, holder }, { reason: data.reason, isCorrection: true });
    await audit(t, actor, { action: 'ASSET_CORRECTED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { locationId: asset.locationId, holder: holderOf(asset), status: asset.status }, after: { locationId, holder, status }, details: { reason: data.reason }, locationIds: [asset.locationId, locationId] });
    return updated;
  });
}

export async function clearDuplicateFlag(actor: Actor, id: string, reason: string) {
  if (actor.role !== 'ADMIN') throw forbidden('Only an Administrator can clear a duplicate flag.');
  if (!reason?.trim()) throw badRequest('A reason is required.');
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, id, t);
    await t.duplicateFlag.updateMany({ where: { OR: [{ assetId: asset.id }, { matchedAssetId: asset.id }], clearedAt: null }, data: { clearedAt: new Date(), clearedById: actor.id, clearReason: reason } });
    const affected = new Set<string>([asset.id]);
    for (const f of await t.duplicateFlag.findMany({ where: { OR: [{ assetId: asset.id }, { matchedAssetId: asset.id }] }, select: { assetId: true, matchedAssetId: true } })) { affected.add(f.assetId); affected.add(f.matchedAssetId); }
    for (const aid of affected) {
      const open = await t.duplicateFlag.count({ where: { OR: [{ assetId: aid }, { matchedAssetId: aid }], clearedAt: null } });
      if (!open) await t.asset.update({ where: { id: aid }, data: { flagDuplicateSuspect: false } });
    }
    await audit(t, actor, { action: 'DUPLICATE_FLAG_CLEARED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, details: { reason }, locationIds: [asset.locationId] });
    return { ok: true };
  });
}

export async function clearFlag(actor: Actor, id: string, flag: 'MISSING' | 'TRANSFER_EXCEPTION', reason: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  if (!reason?.trim()) throw badRequest('A reason is required.');
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, id, t);
    if (flag === 'TRANSFER_EXCEPTION') {
      const open = await t.transferException.count({ where: { assetId: asset.id, status: 'OPEN' } });
      if (open) throw conflict('Resolve the open transfer exception instead of clearing the flag.');
    }
    await t.asset.update({ where: { id: asset.id }, data: flag === 'MISSING' ? { flagMissing: false } : { flagTransferException: false } });
    await audit(t, actor, { action: 'ASSET_FLAG_CLEARED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, details: { flag, reason }, locationIds: [asset.locationId] });
    return { ok: true };
  });
}

// ───────────── Search / list (FR-REG-07) ─────────────

export interface AssetFilters {
  search?: string;
  categoryIds?: string[];
  statuses?: string[];
  locationId?: string;
  regionId?: string;
  holderType?: string;
  holderId?: string;
  warrantyWithinDays?: number;
  warrantyExpired?: boolean;
  flag?: string;
  hasOpenTransfer?: boolean;
  ids?: string[];
  excludeIds?: string[];
}

export async function assetWhere(actor: Actor, f: AssetFilters): Promise<Prisma.AssetWhereInput> {
  const and: Prisma.AssetWhereInput[] = [assetScope(actor)];
  if (f.search) {
    const s = f.search.trim();
    and.push({
      OR: [
        { assetCode: { contains: s, mode: 'insensitive' } }, { legacyTag: { contains: s, mode: 'insensitive' } },
        { serialNumber: { contains: s, mode: 'insensitive' } }, { hostname: { contains: s, mode: 'insensitive' } },
        { ipAddress: { contains: s } }, { make: { contains: s, mode: 'insensitive' } }, { model: { contains: s, mode: 'insensitive' } },
        { holderEmployee: { name: { contains: s, mode: 'insensitive' } } }, { holderEmployee: { employeeCode: { equals: s, mode: 'insensitive' } } },
        { holderDepartment: { name: { contains: s, mode: 'insensitive' } } },
        { category: { name: { equals: s, mode: 'insensitive' } } }, { location: { name: { equals: s, mode: 'insensitive' } } },
      ],
    });
  }
  if (f.categoryIds?.length) and.push({ categoryId: { in: f.categoryIds } });
  if (f.statuses?.length) and.push({ status: { in: f.statuses as Asset['status'][] } });
  for (const lid of [f.locationId, f.regionId]) {
    if (!lid) continue;
    const loc = await prisma.location.findUnique({ where: { id: lid }, select: { idPath: true } });
    and.push({ location: { idPath: { startsWith: loc?.idPath ?? '/__none__/' } } });
  }
  if (f.holderType) and.push(f.holderType === 'NONE' ? { holderType: null } : { holderType: f.holderType as Asset['holderType'] });
  if (f.holderId) and.push({ OR: [{ holderEmployeeId: f.holderId }, { holderDepartmentId: f.holderId }, { holderLocationId: f.holderId }] });
  if (f.warrantyWithinDays !== undefined) {
    const today = dateOnly(todayIST());
    and.push({ warrantyEnd: { gte: today, lte: new Date(today.getTime() + f.warrantyWithinDays * 86_400_000) } });
  }
  if (f.warrantyExpired) and.push({ warrantyEnd: { lt: dateOnly(todayIST()) } });
  if (f.flag === 'TRANSFER_EXCEPTION') and.push({ flagTransferException: true });
  if (f.flag === 'MISSING') and.push({ flagMissing: true });
  if (f.flag === 'DUPLICATE_SUSPECT') and.push({ flagDuplicateSuspect: true });
  if (f.flag === 'ANY') and.push({ OR: [{ flagTransferException: true }, { flagMissing: true }, { flagDuplicateSuspect: true }] });
  const open = { transferLines: { some: { status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] as ('PENDING_APPROVAL' | 'IN_TRANSIT')[] } } } };
  if (f.hasOpenTransfer === true) and.push(open);
  if (f.hasOpenTransfer === false) and.push({ NOT: open });
  if (f.ids?.length) and.push({ id: { in: f.ids } });
  if (f.excludeIds?.length) and.push({ id: { notIn: f.excludeIds } });
  return { AND: and };
}

const SORTS: Record<string, (dir: 'asc' | 'desc') => Prisma.AssetOrderByWithRelationInput> = {
  assetCode: (d) => ({ assetCode: d }), make: (d) => ({ make: d }), model: (d) => ({ model: d }), status: (d) => ({ status: d }),
  serialNumber: (d) => ({ serialNumber: d }), hostname: (d) => ({ hostname: d }), ipAddress: (d) => ({ ipAddress: d }),
  warrantyEnd: (d) => ({ warrantyEnd: d }), createdAt: (d) => ({ createdAt: d }), updatedAt: (d) => ({ updatedAt: d }),
  location: (d) => ({ location: { namePath: d } }), category: (d) => ({ category: { name: d } }), legacyTag: (d) => ({ legacyTag: d }),
};

export const assetListInclude = {
  category: { select: { id: true, name: true } },
  location: { select: { id: true, namePath: true, name: true } },
  holderEmployee: { select: { id: true, name: true, employeeCode: true } },
  holderDepartment: { select: { id: true, name: true } },
  holderLocation: { select: { id: true, namePath: true } },
  transferLines: {
    where: { status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] } },
    select: { status: true, transfer: { select: { id: true, transferNo: true, status: true, toLocation: { select: { namePath: true } } } } },
  },
} satisfies Prisma.AssetInclude;

export type AssetRow = Prisma.AssetGetPayload<{ include: typeof assetListInclude }>;

export function shapeAsset(a: AssetRow) {
  const line = a.transferLines[0];
  return {
    id: a.id, assetCode: a.assetCode, legacyTag: a.legacyTag, category: a.category.name, categoryId: a.categoryId, make: a.make, model: a.model,
    serialNumber: a.serialNumber, hostname: a.hostname, ipAddress: a.ipAddress, macAddress: a.macAddress, status: a.status,
    location: a.location?.namePath ?? null, locationId: a.locationId,
    holderType: a.holderType,
    holder: a.holderEmployee ? `${a.holderEmployee.name} (${a.holderEmployee.employeeCode})` : a.holderDepartment?.name ?? a.holderLocation?.namePath ?? null,
    warrantyEnd: a.warrantyEnd, purchaseCost: a.purchaseCost?.toString() ?? null, vendor: a.vendor,
    flags: [a.flagTransferException && 'Transfer exception', a.flagMissing && 'Missing', a.flagDuplicateSuspect && 'Duplicate-suspect'].filter(Boolean) as string[],
    openTransfer: line ? { id: line.transfer.id, transferNo: line.transfer.transferNo, status: line.status, toLocation: line.transfer.toLocation.namePath } : null,
    updatedAt: a.updatedAt, createdAt: a.createdAt, retiredAt: a.retiredAt, disposalType: a.disposalType, retireReason: a.retireReason,
  };
}

export async function listAssets(actor: Actor, f: AssetFilters, p: { skip: number; take: number; sort?: string; dir?: 'asc' | 'desc' }) {
  const where = await assetWhere(actor, f);
  const orderBy = [(SORTS[p.sort ?? ''] ?? SORTS.assetCode)(p.dir ?? (p.sort ? 'asc' : 'desc')), { id: 'asc' as const }];
  const [rows, total] = await Promise.all([
    prisma.asset.findMany({ where, include: assetListInclude, orderBy, skip: p.skip, take: p.take }),
    prisma.asset.count({ where }),
  ]);
  return { rows: rows.map(shapeAsset), total };
}

export async function getAssetDetail(actor: Actor, idOrCode: string) {
  const a = await getScopedAsset(actor, idOrCode);
  const full = await prisma.asset.findUniqueOrThrow({
    where: { id: a.id },
    include: {
      ...assetListInclude,
      category: true,
      renewables: { where: { status: { not: 'CANCELLED' } }, orderBy: { expiryDate: 'asc' } },
      assignments: { orderBy: { startAt: 'desc' } },
      duplicateLinks: { where: { clearedAt: null }, include: { matchedAsset: { select: { id: true, assetCode: true } } } },
      duplicateOf: { where: { clearedAt: null }, include: { asset: { select: { id: true, assetCode: true } } } },
      deviceData: true,
    },
  });
  const exceptions = await prisma.transferException.findMany({ where: { assetId: a.id, status: 'OPEN' } });
  const pendingApprovals = await prisma.approvalRequest.findMany({ where: { status: 'PENDING', assetIds: { has: a.id } }, select: { id: true, requestNo: true, action: true, summary: true } });
  const users = await prisma.user.findMany({ where: { id: { in: [full.createdById, full.updatedById, full.retiredById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const nm = new Map(users.map((u) => [u.id, u.name]));
  return {
    ...shapeAsset(full as AssetRow),
    raw: {
      purchaseDate: full.purchaseDate, purchaseCost: full.purchaseCost?.toString() ?? null, vendor: full.vendor, condition: full.condition, remarks: full.remarks,
      sdpTicketId: full.sdpTicketId, sdpTicketUrl: full.sdpTicketUrl, origin: full.origin, fieldSources: full.fieldSources,
      holderEmployeeId: full.holderEmployeeId, holderDepartmentId: full.holderDepartmentId, holderLocationId: full.holderLocationId,
      preRepairStatus: full.preRepairStatus, categorySerialRequired: full.category.serialRequired,
      createdBy: nm.get(full.createdById ?? '') ?? (full.createdById ? full.createdById : 'System'), updatedBy: nm.get(full.updatedById ?? '') ?? null, retiredBy: nm.get(full.retiredById ?? '') ?? null,
    },
    renewables: full.renewables,
    assignments: full.assignments,
    duplicates: [
      ...full.duplicateLinks.map((d) => ({ key: d.key, value: d.value, reason: d.reason, other: d.matchedAsset })),
      ...full.duplicateOf.map((d) => ({ key: d.key, value: d.value, reason: d.reason, other: d.asset })),
    ],
    deviceData: full.deviceData,
    exceptions,
    pendingApprovals,
  };
}

/** FR-REG-11: global lookup by Asset ID (or exact serial / legacy tag). */
export async function lookupAsset(actor: Actor, term: string) {
  const s = term.trim();
  if (!s) throw badRequest('Enter an Asset ID.');
  const a = await prisma.asset.findFirst({
    where: { AND: [assetScope(actor), { OR: [{ assetCode: s.toUpperCase() }, { serialNormalized: s.toLowerCase() }, { legacyTagNormalized: s.toLowerCase() }] }] },
    select: { id: true, assetCode: true },
  });
  if (!a) throw notFound('Asset');
  return a;
}
