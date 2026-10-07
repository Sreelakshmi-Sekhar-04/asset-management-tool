import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { dateOnly } from '@/lib/format';
import type { Actor } from '../actor';
import { auditMany } from '../audit';
import { getSettings } from '../settings';
import { syncWarrantyRenewable } from '../services/renewables';
import type { ParsedRow } from './parse';
import { parseDate } from './parse';
import { LocationResolver, type ImportContext, type RowResult, type ValidationResult } from './common';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$|^[0-9A-Fa-f]{12}$/;

/** Fields that Create-or-update may change (never Asset ID, location or holder — FR-IMP-07). */
const UPDATABLE = ['categoryId', 'make', 'model', 'hostname', 'ipAddress', 'macAddress', 'legacyTag', 'serialNumber', 'purchaseDate', 'purchaseCost', 'vendor', 'warrantyEnd', 'condition', 'remarks'] as const;

export interface AssetPlan {
  categoryId: string; make: string; model: string; serialNumber: string | null; hostname: string | null; ipAddress: string | null;
  macAddress: string | null; legacyTag: string | null; locationPath: string; locationId: string | null; holderEmployeeId: string | null;
  /** Holds the asset when the row names a department and no employee. */
  holderDepartmentId: string | null;
  purchaseDate: string | null; purchaseCost: number | null; vendor: string | null; warrantyEnd: string | null; condition: string | null; remarks: string | null;
  fingerprint: string; warnings: { key: string; value: string; matchId: string; matchCode: string }[]; changes?: Record<string, unknown>;
}

type Existing = { id: string; assetCode: string; status: string; serialNormalized: string | null; legacyTagNormalized: string | null; hostnameNormalized: string | null; ipAddress: string | null; importFingerprint: string | null } & Record<string, unknown>;

export async function validateAssets(db: Db, ctx: ImportContext, rows: ParsedRow[], onProgress?: (n: number) => Promise<void>): Promise<ValidationResult<AssetPlan>> {
  const rules = (await getSettings(db)).duplicateRules;
  const categories = await db.assetCategory.findMany();
  const catByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const employees = await db.employee.findMany({ select: { id: true, employeeCode: true, active: true, name: true } });
  const empByCode = new Map(employees.map((e) => [e.employeeCode.toLowerCase(), e]));
  const deptByName = new Map((await db.department.findMany({ select: { id: true, name: true, active: true } })).map((x) => [x.name.toLowerCase(), x]));
  const existing = (await db.asset.findMany({
    select: { id: true, assetCode: true, status: true, serialNormalized: true, legacyTagNormalized: true, hostnameNormalized: true, ipAddress: true, importFingerprint: true, categoryId: true, make: true, model: true, hostname: true, macAddress: true, legacyTag: true, serialNumber: true, purchaseDate: true, purchaseCost: true, vendor: true, warrantyEnd: true, condition: true, remarks: true, locationId: true, holderEmployeeId: true },
  })) as unknown as Existing[];
  const bySerial = new Map<string, Existing>(), byTag = new Map<string, Existing>(), byFp = new Map<string, Existing>();
  const byHost = new Map<string, Existing[]>(), byIp = new Map<string, Existing[]>();
  for (const a of existing) {
    if (a.serialNormalized) bySerial.set(a.serialNormalized, a);
    if (a.legacyTagNormalized) byTag.set(a.legacyTagNormalized, a);
    if (a.importFingerprint) byFp.set(a.importFingerprint, a);
    if (a.status !== 'RETIRED') {
      if (a.hostnameNormalized) byHost.set(a.hostnameNormalized, [...(byHost.get(a.hostnameNormalized) ?? []), a]);
      if (a.ipAddress) byIp.set(a.ipAddress, [...(byIp.get(a.ipAddress) ?? []), a]);
    }
  }
  const locs = new LocationResolver(db, ctx.createMissing);
  await locs.load();
  const fileSerial = new Map<string, number>(), fileTag = new Map<string, number>(), fileHost = new Map<string, number>(), fileIp = new Map<string, number>(), fpCount = new Map<string, number>();
  const results: RowResult<AssetPlan>[] = [];

  for (const [i, r] of rows.entries()) {
    const d = r.data;
    const msgs: string[] = [];
    const warn: string[] = [];
    const g = (k: string) => (d[k] ?? '').trim();
    for (const k of ['category', 'make', 'model', 'location']) if (!g(k)) msgs.push(`${k[0].toUpperCase() + k.slice(1)} is required.`);
    const cat = g('category') ? catByName.get(g('category').toLowerCase()) : undefined;
    if (g('category') && !cat) msgs.push(`Unknown category "${g('category')}".`);
    else if (cat && !cat.active) msgs.push(`Category "${cat.name}" is inactive.`);
    const serial = g('serialnumber') || null;
    if (cat?.serialRequired && !serial) msgs.push(`Serial number is required for category ${cat.name}.`);
    const ip = g('ipaddress') || null;
    if (ip && isIP(ip) === 0) msgs.push(`IP address "${ip}" is not a valid IPv4/IPv6 address.`);
    const mac = g('macaddress') || null;
    if (mac && !MAC_RE.test(mac)) msgs.push(`MAC address "${mac}" is not valid.`);
    const pd = g('purchasedate') ? parseDate(g('purchasedate')) : null;
    if (g('purchasedate') && !pd) msgs.push(`Purchase date "${g('purchasedate')}" is not a valid date (use YYYY-MM-DD or DD-MMM-YYYY).`);
    const we = g('warrantyend') ? parseDate(g('warrantyend')) : null;
    if (g('warrantyend') && !we) msgs.push(`Warranty end "${g('warrantyend')}" is not a valid date (use YYYY-MM-DD or DD-MMM-YYYY).`);
    let cost: number | null = null;
    if (g('purchasecost')) { cost = Number(g('purchasecost').replace(/[,₹\s]/g, '')); if (isNaN(cost) || cost < 0) { msgs.push(`Purchase cost "${g('purchasecost')}" is not a valid amount.`); cost = null; } }
    const loc = g('location') ? locs.resolve(g('location')) : null;
    // A missing location is never created by the dry run: the preview offers "Add location" for it.
    if (g('location') && loc?.kind === 'unknown') msgs.push(locs.isInactive(g('location')) ? `Location "${g('location')}" is inactive.` : `Location not found: "${g('location')}".`);
    if (g('location') && loc?.kind === 'ambiguous') msgs.push(`Location "${g('location')}" matches more than one node; give the full path.`);
    const holderCode = g('holderemployeeid');
    let holderId: string | null = null;
    if (holderCode) {
      const e = empByCode.get(holderCode.toLowerCase());
      if (!e) msgs.push(`Unknown employee "${holderCode}" in the holder column.`);
      else if (!e.active) msgs.push(`Employee ${holderCode} is inactive and cannot hold assets.`);
      else holderId = e.id;
    }
    const deptName = g('department');
    let deptId: string | null = null;
    if (deptName) {
      const x = deptByName.get(deptName.toLowerCase());
      if (!x) msgs.push(`Department not found: "${deptName}".`);
      else if (!x.active) msgs.push(`Department "${x.name}" is inactive.`);
      else deptId = x.id;
    }
    const tag = g('legacytag') || null;
    const host = g('hostname') || null;
    // Within-file duplicates
    if (serial) { const k = serial.toLowerCase(); if (fileSerial.has(k)) msgs.push(`Serial "${serial}" is duplicated within the file (rows ${fileSerial.get(k)} and ${r.rowNumber}).`); else fileSerial.set(k, r.rowNumber); }
    if (tag) { const k = tag.toLowerCase(); if (fileTag.has(k)) msgs.push(`Legacy tag "${tag}" is duplicated within the file (rows ${fileTag.get(k)} and ${r.rowNumber}).`); else fileTag.set(k, r.rowNumber); }
    const plan: AssetPlan = {
      categoryId: cat?.id ?? '', make: g('make'), model: g('model'), serialNumber: serial, hostname: host, ipAddress: ip, macAddress: mac, legacyTag: tag,
      locationPath: g('location'), locationId: loc?.kind === 'found' ? loc.id : null, holderEmployeeId: holderId,
      holderDepartmentId: holderId ? null : deptId, purchaseDate: pd, purchaseCost: cost,
      vendor: g('vendor') || null, warrantyEnd: we, condition: g('condition') || null, remarks: g('remarks') || null, fingerprint: '', warnings: [],
    };
    const base = crypto.createHash('sha256').update(JSON.stringify([plan.categoryId, plan.make.toLowerCase(), plan.model.toLowerCase(), serial?.toLowerCase(), host?.toLowerCase(), ip, mac?.toLowerCase(), tag?.toLowerCase(), plan.locationPath.toLowerCase(), holderCode.toLowerCase(), pd, cost, plan.vendor, we, plan.condition, plan.remarks,
      // Only when given, so files without a Department column keep the fingerprints of earlier imports.
      ...(deptName ? [deptName.toLowerCase()] : [])])).digest('hex').slice(0, 40);
    const occ = (fpCount.get(base) ?? 0) + 1;
    fpCount.set(base, occ);
    plan.fingerprint = `${base}#${occ}`;

    if (msgs.length) {
      // Say up front that the serial is already registered, so it is not found only after the other errors are fixed.
      const taken = ctx.mode === 'CREATE_ONLY' && serial ? bySerial.get(serial.toLowerCase()) : undefined;
      if (taken) msgs.push(`Duplicate: serial ${serial} already exists on ${taken.assetCode}${taken.status === 'RETIRED' ? ' (retired)' : ''}.`);
      results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: msgs, matchedId: taken?.id, plan }); await tick(i); continue;
    }

    // Match existing: serial first, then legacy tag.
    const match = (serial && bySerial.get(serial.toLowerCase())) || (tag && byTag.get(tag.toLowerCase())) || null;
    if (match) {
      const changes: Record<string, unknown> = {};
      const want: Record<string, unknown> = { categoryId: plan.categoryId, make: plan.make, model: plan.model, hostname: host, ipAddress: ip, macAddress: mac, legacyTag: tag, serialNumber: serial, purchaseDate: pd, purchaseCost: cost, vendor: plan.vendor, warrantyEnd: we, condition: plan.condition, remarks: plan.remarks };
      for (const k of UPDATABLE) {
        const nv = want[k];
        if (nv === null || nv === undefined || nv === '') continue; // blank cells never erase data
        const cv = match[k];
        const cvs = cv instanceof Date ? cv.toISOString().slice(0, 10) : cv === null || cv === undefined ? null : typeof cv === 'object' ? String(cv) : String(cv);
        const nvs = String(nv);
        const same = k === 'purchaseCost' ? Number(cvs) === Number(nvs) : (cvs ?? '').toLowerCase() === nvs.toLowerCase();
        if (!same) changes[k] = nv;
      }
      const matchedOn = serial && bySerial.get(serial.toLowerCase()) === match ? `serial ${serial}` : `legacy tag ${tag}`;
      if (!Object.keys(changes).length) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'UNCHANGED', messages: [`Duplicate of ${match.assetCode} (same ${matchedOn}, same details); it will not be imported again.`], matchedId: match.id, plan }); await tick(i); continue; }
      if (ctx.mode === 'CREATE_ONLY') { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [`Duplicate: ${matchedOn} already exists on ${match.assetCode}${match.status === 'RETIRED' ? ' (retired)' : ''}. Use "Create or update" mode to update it.`], matchedId: match.id, plan }); await tick(i); continue; }
      if (match.status === 'RETIRED') { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [`${match.assetCode} (${matchedOn}) is retired and cannot be updated.`], matchedId: match.id, plan }); await tick(i); continue; }
      if (changes.legacyTag && byTag.get(String(changes.legacyTag).toLowerCase()) && byTag.get(String(changes.legacyTag).toLowerCase()) !== match) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [`Legacy tag ${changes.legacyTag} already belongs to ${byTag.get(String(changes.legacyTag).toLowerCase())!.assetCode}.`], matchedId: match.id, plan }); await tick(i); continue; }
      if (changes.serialNumber && bySerial.get(String(changes.serialNumber).toLowerCase()) && bySerial.get(String(changes.serialNumber).toLowerCase()) !== match) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [`Serial ${changes.serialNumber} already belongs to ${bySerial.get(String(changes.serialNumber).toLowerCase())!.assetCode}.`], matchedId: match.id, plan }); await tick(i); continue; }
      const w = dupWarnings(changes.hostname as string, changes.ipAddress as string, match.id);
      if (w.block) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [w.block], matchedId: match.id, plan }); await tick(i); continue; }
      plan.changes = changes;
      plan.warnings = w.warnings;
      results.push({ rowNumber: r.rowNumber, data: d, outcome: w.warnings.length ? 'WARNING' : 'UPDATED', messages: [`Updates ${match.assetCode} (${Object.keys(changes).join(', ')}).`, ...w.messages], matchedId: match.id, plan });
      await tick(i);
      continue;
    }
    // Idempotent re-import of serial-less rows (FR-IMP-08)
    const fpMatch = byFp.get(plan.fingerprint);
    if (fpMatch && !serial && !tag) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'UNCHANGED', messages: [`Duplicate: already imported as ${fpMatch.assetCode}; it will not be imported again.`], matchedId: fpMatch.id, plan }); await tick(i); continue; }
    const w = dupWarnings(host, ip, null);
    if (host) { const k = host.toLowerCase(); if (fileHost.has(k)) w.messages.push(`Hostname "${host}" also appears on row ${fileHost.get(k)}.`); else fileHost.set(k, r.rowNumber); }
    if (ip) { if (fileIp.has(ip)) w.messages.push(`IP "${ip}" also appears on row ${fileIp.get(ip)}.`); else fileIp.set(ip, r.rowNumber); }
    if (w.block) { results.push({ rowNumber: r.rowNumber, data: d, outcome: 'REJECTED', messages: [w.block], plan }); await tick(i); continue; }
    plan.warnings = w.warnings;
    const withinFileWarn = w.messages.length > w.warnings.length;
    const locNote = loc?.kind === 'create' ? [`Location "${loc.path}" will be created.`] : [];
    results.push({ rowNumber: r.rowNumber, data: d, outcome: w.warnings.length || withinFileWarn ? 'WARNING' : 'CREATED', messages: [...w.messages, ...locNote, ...(holderId ? [`Will be assigned to employee ${holderCode}.`] : plan.holderDepartmentId ? [`Will be assigned to department ${deptName}.`] : [])], plan });
    await tick(i);
    void warn;
  }
  return { rows: results, locationsToCreate: locs.toCreate(), departmentsToCreate: [] };

  function dupWarnings(host: string | null | undefined, ip: string | null | undefined, selfId: string | null) {
    const warnings: AssetPlan['warnings'] = [];
    const messages: string[] = [];
    let block: string | null = null;
    if (host && rules.hostname !== 'OFF') for (const m of byHost.get(host.toLowerCase()) ?? []) if (m.id !== selfId) {
      if (rules.hostname === 'BLOCK') block = `Duplicate hostname "${host}" (${m.assetCode}); the hostname rule is set to block.`;
      else { warnings.push({ key: 'hostname', value: host, matchId: m.id, matchCode: m.assetCode }); messages.push(`Possible duplicate: hostname "${host}" is used by ${m.assetCode}.`); }
    }
    if (ip && rules.ip !== 'OFF') for (const m of byIp.get(ip) ?? []) if (m.id !== selfId) {
      if (rules.ip === 'BLOCK') block = `Duplicate IP "${ip}" (${m.assetCode}); the IP rule is set to block.`;
      else { warnings.push({ key: 'ip', value: ip, matchId: m.id, matchCode: m.assetCode }); messages.push(`Possible duplicate: IP "${ip}" is used by ${m.assetCode}.`); }
    }
    return { warnings, messages, block };
  }
  async function tick(i: number) { if (onProgress && i % 500 === 499) await onProgress(i + 1); }
}

/** Apply a validated asset import inside one transaction (called after re-validation matched the dry run). */
export async function applyAssets(t: Db, actor: Actor, jobId: string, v: ValidationResult<AssetPlan>, warningReason: string | null, onProgress?: (n: number) => Promise<void>) {
  const locIds = new LocationResolver(t, true);
  const created = await locIds.createAll(actor, v.locationsToCreate);
  const locationName = new Map((await t.location.findMany({ select: { id: true, namePath: true } })).map((l) => [l.id, l.namePath]));
  const empName = new Map((await t.employee.findMany({ select: { id: true, name: true, employeeCode: true } })).map((e) => [e.id, `${e.name} (${e.employeeCode})`]));
  const deptName = new Map((await t.department.findMany({ select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const results: { rowNumber: number; resultId: string | null; resultCode: string | null }[] = [];
  const toCreate = v.rows.filter((r) => r.outcome === 'CREATED' || (r.outcome === 'WARNING' && !r.matchedId));
  const toUpdate = v.rows.filter((r) => r.outcome === 'UPDATED' || (r.outcome === 'WARNING' && r.matchedId));
  const now = new Date();
  const actorId = actor.id === 'system' ? null : actor.id;
  let done = 0;
  for (let i = 0; i < toCreate.length; i += 1000) {
    const chunk = toCreate.slice(i, i + 1000);
    const rowsData: Prisma.AssetCreateManyInput[] = chunk.map((r) => {
      const p = r.plan!;
      const locationId = p.locationId ?? created.get(LocationResolver.norm(p.locationPath).toLowerCase())!;
      const fs: Record<string, string> = {};
      for (const k of ['make', 'model', 'serialNumber', 'hostname', 'ipAddress', 'macAddress', 'warrantyEnd']) if ((p as unknown as Record<string, unknown>)[k]) fs[k] = 'import';
      return {
        id: crypto.randomUUID(), categoryId: p.categoryId, make: p.make, model: p.model, serialNumber: p.serialNumber, hostname: p.hostname, ipAddress: p.ipAddress,
        macAddress: p.macAddress, legacyTag: p.legacyTag, purchaseDate: p.purchaseDate ? dateOnly(p.purchaseDate) : null, purchaseCost: p.purchaseCost,
        vendor: p.vendor, warrantyEnd: p.warrantyEnd ? dateOnly(p.warrantyEnd) : null, condition: p.condition, remarks: p.remarks, locationId,
        status: p.holderEmployeeId || p.holderDepartmentId ? 'ASSIGNED' : 'IN_STOCK', holderType: p.holderEmployeeId ? 'EMPLOYEE' : p.holderDepartmentId ? 'DEPARTMENT' : null,
        holderEmployeeId: p.holderEmployeeId, holderDepartmentId: p.holderDepartmentId ?? null,
        origin: 'import', fieldSources: fs, importFingerprint: p.serialNumber || p.legacyTag ? null : p.fingerprint,
        flagDuplicateSuspect: p.warnings.length > 0, createdById: actorId, updatedById: actorId,
      };
    });
    await t.asset.createMany({ data: rowsData });
    const codes = new Map((await t.asset.findMany({ where: { id: { in: rowsData.map((x) => x.id!) } }, select: { id: true, assetCode: true } })).map((a) => [a.id, a.assetCode]));
    const movements: Prisma.AssetMovementCreateManyInput[] = [];
    const assignments: Prisma.AssetAssignmentCreateManyInput[] = [];
    const dupFlags: Prisma.DuplicateFlagCreateManyInput[] = [];
    chunk.forEach((r, j) => {
      const a = rowsData[j];
      const ln = locationName.get(a.locationId!) ?? null;
      movements.push({ assetId: a.id!, kind: 'IMPORTED', toLocationId: a.locationId, toLocationName: ln, toStatus: 'IN_STOCK', effectiveAt: now, actorId, actorName: actor.name, reason: `Imported (row ${r.rowNumber})` });
      if (a.holderEmployeeId) {
        const hn = empName.get(a.holderEmployeeId) ?? a.holderEmployeeId;
        movements.push({ assetId: a.id!, kind: 'ASSIGNED', fromLocationId: a.locationId, fromLocationName: ln, toLocationId: a.locationId, toLocationName: ln, fromStatus: 'IN_STOCK', toStatus: 'ASSIGNED', toHolderType: 'EMPLOYEE', toHolderId: a.holderEmployeeId, toHolderName: hn, effectiveAt: new Date(now.getTime() + 1), actorId, actorName: actor.name, reason: 'Imported' });
        assignments.push({ assetId: a.id!, holderType: 'EMPLOYEE', holderId: a.holderEmployeeId, holderName: hn, startAt: now, assignedById: actorId, source: 'IMPORT' });
      } else if (a.holderDepartmentId) {
        const hn = deptName.get(a.holderDepartmentId) ?? a.holderDepartmentId;
        movements.push({ assetId: a.id!, kind: 'ASSIGNED', fromLocationId: a.locationId, fromLocationName: ln, toLocationId: a.locationId, toLocationName: ln, fromStatus: 'IN_STOCK', toStatus: 'ASSIGNED', toHolderType: 'DEPARTMENT', toHolderId: a.holderDepartmentId, toHolderName: hn, effectiveAt: new Date(now.getTime() + 1), actorId, actorName: actor.name, reason: 'Imported' });
        assignments.push({ assetId: a.id!, holderType: 'DEPARTMENT', holderId: a.holderDepartmentId, holderName: hn, startAt: now, assignedById: actorId, source: 'IMPORT' });
      }
      for (const w of r.plan!.warnings) {
        dupFlags.push({ assetId: a.id!, matchedAssetId: w.matchId, key: w.key, value: w.value, reason: warningReason ?? 'Accepted during import', createdById: actorId });
      }
      results.push({ rowNumber: r.rowNumber, resultId: a.id!, resultCode: codes.get(a.id!) ?? null });
    });
    await t.assetMovement.createMany({ data: movements });
    if (assignments.length) await t.assetAssignment.createMany({ data: assignments });
    if (dupFlags.length) {
      await t.duplicateFlag.createMany({ data: dupFlags });
      await t.asset.updateMany({ where: { id: { in: dupFlags.map((f) => f.matchedAssetId) } }, data: { flagDuplicateSuspect: true } });
    }
    await auditMany(t, actor, chunk.map((r, j) => ({ action: 'ASSET_CREATED', entityType: 'Asset', entityId: rowsData[j].id!, entityLabel: codes.get(rowsData[j].id!), after: { ...r.plan, fingerprint: undefined, warnings: undefined }, details: { importJobId: jobId, row: r.rowNumber, duplicateWarnings: r.plan!.warnings.length ? r.plan!.warnings : undefined, warningReason: r.plan!.warnings.length ? warningReason : undefined }, locationIds: [rowsData[j].locationId] })));
    for (const a of rowsData) if (a.warrantyEnd) await syncWarrantyRenewable(t, actor, { id: a.id!, assetCode: codes.get(a.id!)!, make: a.make, model: a.model, vendor: a.vendor ?? null, warrantyEnd: a.warrantyEnd as Date, purchaseDate: (a.purchaseDate as Date) ?? null }, 'import');
    done += chunk.length;
    await onProgress?.(done);
  }
  for (const r of toUpdate) {
    const p = r.plan!;
    const before = await t.asset.findUniqueOrThrow({ where: { id: r.matchedId! } });
    const data: Record<string, unknown> = { ...p.changes };
    if (data.purchaseDate) data.purchaseDate = dateOnly(String(data.purchaseDate));
    if (data.warrantyEnd) data.warrantyEnd = dateOnly(String(data.warrantyEnd));
    const fs = { ...(before.fieldSources as Record<string, string>) };
    for (const k of Object.keys(data)) fs[k] = 'import';
    const after = await t.asset.update({ where: { id: before.id }, data: { ...data, fieldSources: fs, updatedById: actorId, ...(p.warnings.length ? { flagDuplicateSuspect: true } : {}) } });
    if (p.warnings.length) {
      await t.duplicateFlag.createMany({ data: p.warnings.map((w) => ({ assetId: before.id, matchedAssetId: w.matchId, key: w.key, value: w.value, reason: warningReason ?? 'Accepted during import', createdById: actorId })) });
      await t.asset.updateMany({ where: { id: { in: p.warnings.map((w) => w.matchId) } }, data: { flagDuplicateSuspect: true } });
    }
    const b: Record<string, unknown> = {}; const a: Record<string, unknown> = {};
    for (const k of Object.keys(data)) { b[k] = (before as unknown as Record<string, unknown>)[k]; a[k] = data[k]; }
    await auditMany(t, actor, [{ action: 'ASSET_UPDATED', entityType: 'Asset', entityId: before.id, entityLabel: before.assetCode, before: b, after: a, details: { importJobId: jobId, row: r.rowNumber }, locationIds: [before.locationId] }]);
    if ('warrantyEnd' in data) await syncWarrantyRenewable(t, actor, after, 'import');
    results.push({ rowNumber: r.rowNumber, resultId: before.id, resultCode: before.assetCode });
    done++;
    if (done % 200 === 0) await onProgress?.(done);
  }
  void prisma;
  return results;
}
