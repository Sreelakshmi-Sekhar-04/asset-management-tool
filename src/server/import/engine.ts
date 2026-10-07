import type { ImportJob, ImportType, Prisma } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { prisma, tx, type Db } from '@/lib/db';
import { AppError, badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit } from '../audit';
import { notifyUsers } from '../notify';
import { actorForUser } from '../services/approvals';
import { deleteObject, getObject, newKey, putObject } from '../storage';
import { getSettings } from '../settings';
import { enqueue } from '../jobs/queue';
import { parseTabular, type ParsedRow } from './parse';
import { aliasMap, COLUMNS } from './templates';
import { applyAssets, validateAssets } from './assets';
import { applyBranchUsers, applyEmployees, validateBranchUsers, validateEmployees } from './employees';
import type { RowResult, ValidationResult } from './common';
import { importRowStatus, LOCATION_MISSING, DEPARTMENT_MISSING, missingValue, ROW_FILTERS, type ImportRowStatus } from '@/lib/import-row-status';

/**
 * Starts the dry run of an uploaded file. There is no mode to choose: each row is matched against
 * the register, so a new record is created, an existing one is updated, and one already there with
 * the same details is reported as a duplicate. (`mode` is kept for callers that still pass it.)
 */
export async function startImport(actor: Actor, p: { type: ImportType; mode?: 'CREATE_ONLY' | 'CREATE_OR_UPDATE'; createMissing: boolean; fileName: string; data: Buffer }) {
  const mode = p.mode ?? 'CREATE_OR_UPDATE';
  if (actor.role === 'BRANCH_USER') {
    await audit(prisma, actor, { action: 'ACCESS_DENIED', entityType: 'Import', details: { attempted: 'import', type: p.type } });
    throw forbidden('Imports are an IT function.');
  }
  if (p.type === 'BRANCH_USERS' && actor.role !== 'ADMIN') throw forbidden('Only Administrators can bulk-create users.');
  if (!/\.(csv|xlsx)$/i.test(p.fileName)) throw badRequest('Upload a .csv or .xlsx file.');
  if (p.data.length > 25 * 1024 * 1024) throw badRequest('The file is larger than 25 MB.');
  // Parse synchronously once so that a malformed file is rejected immediately with no job left behind (TC-IMP-15).
  await parseTabular(p.fileName, p.data, aliasMap(COLUMNS[p.type]));
  const key = newKey('imports', p.fileName.toLowerCase().endsWith('.csv') ? '.csv' : '.xlsx');
  await putObject(key, p.data);
  // Asset imports never create locations: a missing one is added from the preview, by a person.
  const createMissing = p.type !== 'ASSETS' && p.createMissing;
  const job = await prisma.importJob.create({ data: { type: p.type, mode, createMissing, fileName: p.fileName.slice(0, 200), storageKey: key, createdById: actor.id, createdByName: actor.name } });
  await enqueue('import.validate', { jobId: job.id });
  await audit(prisma, actor, { action: 'IMPORT_UPLOADED', entityType: 'Import', entityId: job.id, entityLabel: job.fileName, details: { type: p.type, mode, createMissing, bytes: p.data.length } });
  return job;
}

/**
 * The rows to check. The first dry run reads the uploaded file; after that the stored rows are the
 * source, because they carry the corrections made in the preview, and those are what get imported.
 * Rows removed from the batch in the preview are left out: they are no longer part of the import.
 */
async function sourceRows(db: Db, job: ImportJob): Promise<ParsedRow[]> {
  if (job.validatedAt) {
    const stored = await db.importRow.findMany({ where: { jobId: job.id }, orderBy: { rowNumber: 'asc' }, select: { rowNumber: true, data: true, removed: true } });
    if (stored.length) return stored.filter((r) => !r.removed).map((r) => ({ rowNumber: r.rowNumber, data: r.data as Record<string, string> }));
  }
  const { rows } = await parseTabular(job.fileName, await getObject(job.storageKey), aliasMap(COLUMNS[job.type]));
  await db.importJob.update({ where: { id: job.id }, data: { totalRows: rows.length } });
  return rows;
}

async function validate(job: ImportJob, onProgress?: (n: number) => Promise<void>, db: Db = prisma): Promise<ValidationResult<unknown>> {
  const rows = await sourceRows(db, job);
  const ctx = { mode: job.mode, createMissing: job.createMissing };
  if (job.type === 'ASSETS') return validateAssets(db, ctx, rows, onProgress);
  if (job.type === 'EMPLOYEES') return validateEmployees(db, ctx, rows);
  return validateBranchUsers(db, ctx, rows);
}

function countOutcomes(rows: RowResult<unknown>[]) {
  const c: Record<string, number> = { CREATED: 0, UPDATED: 0, UNCHANGED: 0, WARNING: 0, REJECTED: 0, total: rows.length };
  for (const r of rows) c[r.outcome]++;
  return c;
}

/** Worker step 1: dry run — nothing is saved except the report (FR-IMP-03). */
export async function runValidation(jobId: string) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job || (job.status !== 'QUEUED' && job.status !== 'VALIDATING')) return;
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'VALIDATING', processedRows: 0 } });
  try {
    const v = await validate(job, (n) => prisma.importJob.update({ where: { id: jobId }, data: { processedRows: n } }).then(() => undefined));
    await prisma.importRow.deleteMany({ where: { jobId } });
    for (let i = 0; i < v.rows.length; i += 2000) {
      await prisma.importRow.createMany({ data: v.rows.slice(i, i + 2000).map((r) => ({ jobId, rowNumber: r.rowNumber, data: r.data, outcome: r.outcome, messages: r.messages, matchedId: r.matchedId ?? null })) });
    }
    const counts = countOutcomes(v.rows);
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'VALIDATED', processedRows: v.rows.length, totalRows: v.rows.length, counts, locationsToCreate: v.locationsToCreate, departmentsToCreate: v.departmentsToCreate, validatedAt: new Date() } });
    await audit(prisma, await actorForUser(prisma, job.createdById), { action: 'IMPORT_DRY_RUN', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: counts });
    await notifyUsers(prisma, [job.createdById], { type: 'IMPORT_COMPLETED', title: `Dry run finished: ${job.fileName}`, body: `${counts.CREATED} to create, ${counts.UPDATED} to update, ${counts.UNCHANGED} duplicate, ${counts.WARNING} warnings, ${counts.REJECTED} rejected. Review, fix any rows and confirm to import.`, link: `/imports/${jobId}`, eventKey: `import:${jobId}:validated` });
  } catch (e) {
    const msg = e instanceof AppError ? e.message : `Validation failed: ${(e as Error).message}`;
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: msg } });
  }
}

const IMPORTABLE = ['CREATED', 'UPDATED', 'WARNING'] as const;

/**
 * Confirms a dry run. Every row is checked again first, then only the rows that are selected, valid
 * and not removed are queued for import. `expected` is the number of rows the user saw would be
 * imported: if the final check finds a different number, nothing is queued and the preview shows why.
 */
export async function confirmImport(actor: Actor, jobId: string, warningReason?: string, expected?: number) {
  const r = await tx(async (t) => {
    const job = await lockForEdit(t, actor, jobId);
    await recheck(t, job);
    const live = { jobId, removed: false, selected: true };
    const [importable, warnings] = await Promise.all([
      t.importRow.count({ where: { ...live, outcome: { in: [...IMPORTABLE] } } }),
      t.importRow.count({ where: { ...live, outcome: 'WARNING' } }),
    ]);
    if (expected !== undefined && importable !== expected) return { changed: true as const, importable };
    if (!importable) throw badRequest('Nothing to import: no selected row is valid. Tick the rows to import, or fix the rows that still have problems.');
    if (warnings > 0 && !warningReason?.trim()) throw badRequest(`${warnings} selected row(s) carry duplicate warnings. Give a reason to accept them.`, [{ field: 'warningReason', message: 'Required' }]);
    await t.importJob.update({ where: { id: jobId }, data: { status: 'COMMIT_QUEUED', warningReason: warningReason ?? null, committedById: actor.id, processedRows: 0 } });
    await audit(t, actor, { action: 'IMPORT_CONFIRMED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: { warningReason, rowsToImport: importable } });
    return { changed: false as const, importable };
  }, { timeoutMs: 5 * 60_000 });
  if (r.changed) throw conflict(`The final check changed the result: ${r.importable} selected row(s) can be imported now. Nothing was imported; review the rows and confirm again.`);
  await enqueue('import.commit', { jobId });
  return { ok: true, rows: r.importable };
}

export async function cancelImport(actor: Actor, jobId: string) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Import');
  if (!['QUEUED', 'VALIDATED', 'FAILED'].includes(job.status)) throw conflict('This import can no longer be cancelled.');
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'CANCELLED' } });
  await audit(prisma, actor, { action: 'IMPORT_CANCELLED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName });
  return { ok: true };
}

/** Preview cells that can be corrected before confirming. Asset ID is never one: it is assigned on import. */
export const EDITABLE_ASSET_FIELDS = ['serialnumber', 'make', 'model', 'category', 'legacytag', 'ipaddress', 'hostname', 'macaddress', 'location', 'department', 'holderemployeeid', 'purchasedate', 'purchasecost', 'vendor', 'warrantyend', 'condition', 'remarks'] as const;

/**
 * Re-checks every row of a dry run waiting for confirmation, using the stored (possibly corrected)
 * values, and stores the new results and counts. Every row is checked again because a change on one
 * row can clear or create a repeat on another.
 */
async function recheck(t: Db, job: ImportJob) {
  const v = await validate(job, undefined, t);
  const stored = new Map((await t.importRow.findMany({ where: { jobId: job.id }, select: { rowNumber: true, outcome: true, messages: true, matchedId: true } })).map((r) => [r.rowNumber, r]));
  for (const r of v.rows) {
    const s = stored.get(r.rowNumber);
    if (s && s.outcome === r.outcome && s.matchedId === (r.matchedId ?? null) && s.messages.join('\n') === r.messages.join('\n')) continue;
    await t.importRow.update({ where: { jobId_rowNumber: { jobId: job.id, rowNumber: r.rowNumber } }, data: { outcome: r.outcome, messages: r.messages, matchedId: r.matchedId ?? null } });
  }
  const counts = countOutcomes(v.rows);
  await t.importJob.update({ where: { id: job.id }, data: { counts, locationsToCreate: v.locationsToCreate, departmentsToCreate: v.departmentsToCreate } });
  return counts;
}

/** Locks a dry run waiting for confirmation, so an edit and a confirm cannot interleave. */
async function lockForEdit(t: Db, actor: Actor, jobId: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  await t.$queryRaw`SELECT id FROM import_jobs WHERE id = ${jobId} FOR UPDATE`;
  const job = await t.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Import');
  if (job.status !== 'VALIDATED') throw conflict('This import is no longer waiting for confirmation, so its rows cannot be changed.');
  return job;
}

/**
 * Corrects one row of an asset dry run before it is confirmed (a missing serial, a wrong category,
 * an unknown location…), then checks the whole file again. Nothing is imported until "Confirm".
 */
export async function editImportRow(actor: Actor, jobId: string, rowNumber: number, changes: Record<string, string>) {
  return tx(async (t) => {
    const job = await lockForEdit(t, actor, jobId);
    if (job.type !== 'ASSETS') throw badRequest('Only asset imports can be corrected in the preview.');
    const row = await t.importRow.findUnique({ where: { jobId_rowNumber: { jobId, rowNumber } } });
    if (!row) throw notFound('Import row');
    const data = { ...(row.data as Record<string, string>) };
    const before: Record<string, string> = {}, after: Record<string, string> = {};
    for (const [k, raw] of Object.entries(changes)) {
      if (!(EDITABLE_ASSET_FIELDS as readonly string[]).includes(k)) throw badRequest(`"${k}" cannot be changed in the preview.`);
      const v = raw.trim();
      if ((data[k] ?? '') === v) continue;
      before[k] = data[k] ?? ''; after[k] = v;
      data[k] = v;
    }
    if (!Object.keys(after).length) return { counts: job.counts, changed: false };
    await t.importRow.update({ where: { id: row.id }, data: { data } });
    const counts = await recheck(t, job);
    await audit(t, actor, { action: 'IMPORT_ROW_EDITED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, before, after, details: { row: rowNumber } });
    return { counts, changed: true };
  }, { timeoutMs: 5 * 60_000 });
}

/** "Check again": re-runs the checks on the stored rows, e.g. after someone registered one of the serials meanwhile. */
export async function revalidateImport(actor: Actor, jobId: string) {
  return tx(async (t) => ({ counts: await recheck(t, await lockForEdit(t, actor, jobId)) }), { timeoutMs: 5 * 60_000 });
}

/**
 * Ticks or unticks rows of the preview (`rows`), or every row still in the batch (`all`).
 * Only ticked rows are imported; ticking never changes a row's data or its check.
 */
export async function setRowSelection(actor: Actor, jobId: string, p: { rows?: number[]; all?: boolean; selected: boolean }) {
  return tx(async (t) => {
    await lockForEdit(t, actor, jobId);
    if (!p.all && !p.rows?.length) throw badRequest('Choose the rows to select.');
    const n = await t.importRow.updateMany({ where: { jobId, removed: false, ...(p.all ? {} : { rowNumber: { in: p.rows } }) }, data: { selected: p.selected } });
    return { updated: n.count };
  });
}

/**
 * Removes rows from this import batch (Delete in the preview). Only the uploaded rows are taken out:
 * nothing in the register, no location and no department is ever deleted here. The rows are kept,
 * marked removed, so they can be put back; the rest of the batch is checked again without them.
 */
export async function removeImportRows(actor: Actor, jobId: string, which: number[] | 'selected', removed = true) {
  return tx(async (t) => {
    const job = await lockForEdit(t, actor, jobId);
    if (job.type !== 'ASSETS') throw badRequest('Only rows of an asset import can be removed in the preview.');
    const rowNumbers = which === 'selected'
      ? (await t.importRow.findMany({ where: { jobId, removed: false, selected: true }, select: { rowNumber: true } })).map((r) => r.rowNumber)
      : which;
    if (!rowNumbers.length) throw badRequest(which === 'selected' ? 'No row is selected.' : 'Choose the rows to remove.');
    const n = await t.importRow.updateMany({ where: { jobId, rowNumber: { in: rowNumbers }, removed: !removed }, data: { removed, ...(removed ? {} : { selected: true }) } });
    if (!n.count) return { updated: 0, counts: job.counts };
    const counts = await recheck(t, job);
    await audit(t, actor, { action: removed ? 'IMPORT_ROWS_REMOVED' : 'IMPORT_ROWS_RESTORED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: { rows: rowNumbers } });
    return { updated: n.count, counts };
  }, { timeoutMs: 5 * 60_000 });
}

/**
 * After a location or department was added from the preview under a different name than the file
 * used, points every row with the old value at the new one, then checks the batch again.
 */
export async function replaceImportValue(actor: Actor, jobId: string, p: { field: 'location' | 'department'; from: string; to: string }) {
  return tx(async (t) => {
    const job = await lockForEdit(t, actor, jobId);
    if (job.type !== 'ASSETS') throw badRequest('Only asset imports can be corrected in the preview.');
    const from = p.from.trim().toLowerCase();
    const rows = await t.importRow.findMany({ where: { jobId, removed: false }, select: { id: true, rowNumber: true, data: true } });
    const hit = rows.filter((r) => String((r.data as Record<string, string>)[p.field] ?? '').trim().toLowerCase() === from);
    for (const r of hit) await t.importRow.update({ where: { id: r.id }, data: { data: { ...(r.data as Record<string, string>), [p.field]: p.to.trim() } } });
    const counts = await recheck(t, job);
    if (hit.length) await audit(t, actor, { action: 'IMPORT_ROW_EDITED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, before: { [p.field]: p.from }, after: { [p.field]: p.to }, details: { rows: hit.map((r) => r.rowNumber) } });
    return { updated: hit.length, counts };
  }, { timeoutMs: 5 * 60_000 });
}

/** Worker step 2: re-validate against the current database, then apply atomically. */
export async function runCommit(jobId: string) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job || (job.status !== 'COMMIT_QUEUED' && job.status !== 'COMMITTING')) return;
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTING', processedRows: 0 } });
  const actor = await actorForUser(prisma, job.committedById ?? job.createdById);
  try {
    const all = await validate(job);
    const storedRows = await prisma.importRow.findMany({ where: { jobId, removed: false }, select: { rowNumber: true, outcome: true, selected: true } });
    const stored = new Map(storedRows.map((r) => [r.rowNumber, r.outcome]));
    // Only the rows ticked in the preview are imported; the others stay in the report as they are.
    const picked = new Set(storedRows.filter((r) => r.selected).map((r) => r.rowNumber));
    const v = { ...all, rows: all.rows.filter((r) => picked.has(r.rowNumber)) };
    const drift = v.rows.filter((r) => stored.get(r.rowNumber) !== r.outcome);
    if (drift.length) {
      const msg = `The data changed since the dry run, so nothing was applied. ${drift.length} row(s) now have a different result (e.g. row ${drift[0].rowNumber}: was ${stored.get(drift[0].rowNumber)}, now ${drift[0].outcome} — ${drift[0].messages.join(' ')}). Upload the file again to re-run the dry run.`;
      await prisma.importJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: msg } });
      await notifyUsers(prisma, [job.createdById], { type: 'IMPORT_COMPLETED', title: `Import not committed: ${job.fileName}`, body: msg, link: `/imports/${jobId}`, eventKey: `import:${jobId}:drift` });
      return;
    }
    let afterCommit: (() => Promise<void>) | null = null;
    const results = await tx(async (t) => {
      const progress = (n: number) => prisma.importJob.update({ where: { id: jobId }, data: { processedRows: n } }).then(() => undefined);
      if (job.type === 'ASSETS') return applyAssets(t, actor, jobId, v as never, job.warningReason, progress);
      if (job.type === 'EMPLOYEES') return applyEmployees(t, actor, jobId, v as never);
      const r = await applyBranchUsers(t, actor, jobId, v as never);
      afterCommit = r.afterCommit;
      return r.results;
    }, { timeoutMs: 15 * 60_000 });
    for (const r of results) await prisma.importRow.update({ where: { jobId_rowNumber: { jobId, rowNumber: r.rowNumber } }, data: { resultId: r.resultId, resultCode: r.resultCode } });
    // Counts of what was done: importable rows that were not ticked are counted apart, not as created.
    const skipped = all.rows.filter((r) => !picked.has(r.rowNumber) && (IMPORTABLE as readonly string[]).includes(r.outcome));
    const counts: Record<string, number> = { ...countOutcomes(all.rows.filter((r) => !skipped.includes(r))), total: all.rows.length, NOT_SELECTED: skipped.length };
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTED', committedAt: new Date(), processedRows: v.rows.length, counts } });
    if (afterCommit) await (afterCommit as () => Promise<void>)();
    await audit(prisma, actor, { action: 'IMPORT_COMMITTED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: { type: job.type, mode: job.mode, ...counts, locationsCreated: job.locationsToCreate } });
    await notifyUsers(prisma, [job.createdById], { type: 'IMPORT_COMPLETED', title: `Import committed: ${job.fileName}`, body: `${counts.CREATED} created, ${counts.UPDATED} updated, ${counts.WARNING} with warnings, ${counts.UNCHANGED} duplicate, ${counts.REJECTED} rejected${counts.NOT_SELECTED ? `, ${counts.NOT_SELECTED} not selected` : ""}.`, link: `/imports/${jobId}`, eventKey: `import:${jobId}:committed` });
  } catch (e) {
    const msg = e instanceof AppError ? e.message : `Commit failed and was rolled back: ${(e as Error).message}`;
    console.error('[import] commit failed', e);
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: msg } });
    await notifyUsers(prisma, [job.createdById], { type: 'IMPORT_COMPLETED', title: `Import failed: ${job.fileName}`, body: msg, link: `/imports/${jobId}`, eventKey: `import:${jobId}:failed` });
  }
}

// ───────────── Queries / report ─────────────

export async function listImports(actor: Actor, p: { type?: string; skip: number; take: number }) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  const where: Prisma.ImportJobWhereInput = p.type ? { type: p.type as ImportType } : {};
  const [rows, total] = await Promise.all([prisma.importJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, omit: { storageKey: true } }), prisma.importJob.count({ where })]);
  return { rows, total };
}

export async function getImport(actor: Actor, id: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  const job = await prisma.importJob.findUnique({ where: { id }, omit: { storageKey: true } });
  if (!job) throw notFound('Import');
  return job.type === 'ASSETS' && job.validatedAt ? { ...job, preview: await previewSummary(id) } : job;
}

/**
 * What the Excel Upload preview needs beyond the outcome counts: how many rows are ticked and would
 * be imported, how many were removed, each row status, and every location and department the file
 * names that does not exist yet (with how many rows wait for it).
 */
async function previewSummary(jobId: string) {
  const rows = await prisma.importRow.findMany({ where: { jobId }, select: { rowNumber: true, outcome: true, messages: true, selected: true, removed: true } });
  const statuses: Record<string, number> = {};
  const missing = { locations: new Map<string, { value: string; rows: number }>(), departments: new Map<string, { value: string; rows: number }>() };
  let selected = 0, importable = 0, removed = 0, warnings = 0, total = 0, selectedProblems = 0;
  for (const r of rows) {
    if (r.removed) { removed++; continue; }
    total++;
    const st = importRowStatus(r.outcome, r.messages);
    statuses[st] = (statuses[st] ?? 0) + 1;
    if (r.selected) { selected++; if ((IMPORTABLE as readonly string[]).includes(r.outcome)) importable++; if (r.outcome === 'WARNING') warnings++; if (r.outcome === 'REJECTED') selectedProblems++; }
    for (const m of r.messages) {
      const into = LOCATION_MISSING.test(m) ? missing.locations : DEPARTMENT_MISSING.test(m) ? missing.departments : null;
      if (!into) continue;
      const v = missingValue(m);
      const e = into.get(v.toLowerCase()) ?? { value: v, rows: 0 };
      e.rows++;
      into.set(v.toLowerCase(), e);
    }
  }
  return { total, selected, importable, removed, warnings, selectedProblems, statuses, missingLocations: [...missing.locations.values()], missingDepartments: [...missing.departments.values()] };
}

/** Row numbers of the batch whose status is one of these (statuses depend on the messages, so they are worked out here). */
async function rowsWithStatus(jobId: string, statuses: ImportRowStatus[]) {
  const rows = await prisma.importRow.findMany({ where: { jobId, removed: false }, select: { rowNumber: true, outcome: true, messages: true } });
  return rows.filter((r) => statuses.includes(importRowStatus(r.outcome, r.messages))).map((r) => r.rowNumber);
}

export async function importRows(actor: Actor, id: string, p: { outcome?: string; skip: number; take: number }) {
  const job = await getImport(actor, id);
  // `outcome` is a preview tab (Valid, Missing location, Removed…) or, as before, a stored outcome.
  const tab = ROW_FILTERS.find((f) => f.value === p.outcome);
  const where: Prisma.ImportRowWhereInput = { jobId: id };
  if (job.type === 'ASSETS') where.removed = p.outcome === 'REMOVED';
  if (tab?.statuses) where.rowNumber = { in: await rowsWithStatus(id, tab.statuses) };
  else if (p.outcome && p.outcome !== 'REMOVED') where.outcome = p.outcome as RowResult<unknown>['outcome'];
  const [rows, total] = await Promise.all([prisma.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip: p.skip, take: p.take }), prisma.importRow.count({ where })]);
  if (job.type !== 'ASSETS') return { rows, total };
  return { rows: await withAssetView(rows), total };
}

/**
 * Adds what the asset register would show for each row, so the preview reads like the register:
 * the holder's name, and for rows that match or created an asset, its Asset ID and current status.
 */
async function withAssetView<R extends { data: Prisma.JsonValue; outcome: string; matchedId: string | null; resultId: string | null }>(rows: R[]) {
  const codes = [...new Set(rows.map((r) => String((r.data as Record<string, string>).holderemployeeid ?? '').trim().toLowerCase()).filter(Boolean))];
  const assetIds = [...new Set(rows.flatMap((r) => [r.resultId, r.matchedId]).filter((x): x is string => !!x))];
  const [emps, assets] = await Promise.all([
    codes.length ? prisma.employee.findMany({ where: { employeeCode: { in: codes, mode: 'insensitive' } }, select: { employeeCode: true, name: true } }) : [],
    assetIds.length ? prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, assetCode: true, status: true, make: true, model: true, serialNumber: true, legacyTag: true, category: { select: { name: true } } } }) : [],
  ]);
  const empName = new Map(emps.map((e) => [e.employeeCode.toLowerCase(), e.name]));
  const byId = new Map(assets.map((a) => [a.id, a]));
  return rows.map((r) => {
    const code = String((r.data as Record<string, string>).holderemployeeid ?? '').trim();
    const full = byId.get(r.resultId ?? '') ?? byId.get(r.matchedId ?? '') ?? null;
    const a = full && { id: full.id, assetCode: full.assetCode, status: full.status };
    const m = r.outcome !== 'CREATED' && !r.resultId ? byId.get(r.matchedId ?? '') : undefined;
    return { ...r, view: { holderName: code ? empName.get(code.toLowerCase()) ?? null : null, asset: a, duplicate: m ? duplicateOf(r.data as Record<string, string>, m) : null } };
  });
}

/**
 * For a row that matches an asset already in the register: which field matched, the value
 * uploaded, and the existing asset, so the preview can say exactly why the row is a duplicate.
 */
function duplicateOf(d: Record<string, string>, a: { id: string; assetCode: string; status: string; make: string; model: string; serialNumber: string | null; legacyTag: string | null; category: { name: string } }) {
  const v = (k: string) => String(d[k] ?? '').trim();
  const same = (x: string, y: string | null) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
  const [field, fieldLabel, value] = same(v('serialnumber'), a.serialNumber) ? ['serial', 'Serial number', v('serialnumber')]
    : same(v('legacytag'), a.legacyTag) ? ['legacyTag', 'Legacy tag', v('legacytag')]
    : ['details', 'All details (no serial number or legacy tag)', [v('make'), v('model')].filter(Boolean).join(' ')];
  return { field, fieldLabel, value, asset: { id: a.id, assetCode: a.assetCode, name: `${a.make} ${a.model}`, category: a.category.name, serialNumber: a.serialNumber, legacyTag: a.legacyTag, status: a.status } };
}

/** FR-IMP-05: every row with its original row number, outcome and reason, as CSV. */
export async function importReportCsv(actor: Actor, id: string) {
  const job = await getImport(actor, id);
  if (job.reportPurgedAt) throw conflict(`The row report for ${job.fileName} was removed on ${job.reportPurgedAt.toISOString().slice(0, 10)} under the import retention setting. The import log entry and its counts remain.`);
  const rows = await prisma.importRow.findMany({ where: { jobId: id }, orderBy: { rowNumber: 'asc' } });
  const cols = COLUMNS[job.type].map((c) => c.key);
  const header = ['Row', 'Outcome', 'Selected', 'Reason', 'Result ID', ...COLUMNS[job.type].map((c) => c.header)];
  const outcomeLabel = (o: string) => ({ CREATED: 'New', UPDATED: 'Existing', UNCHANGED: 'Duplicate', WARNING: 'Possible duplicate', REJECTED: 'Invalid' } as Record<string, string>)[o] ?? o;
  const lines = rows.map((r) => [r.rowNumber, r.removed ? 'Removed from the import' : outcomeLabel(r.outcome), r.removed ? '' : r.selected ? 'Yes' : 'No', r.messages.join(' | '), r.resultCode ?? '', ...cols.map((k) => (r.data as Record<string, string>)[k] ?? '')]);
  await audit(prisma, actor, { action: 'EXPORT', entityType: 'Import', entityId: id, entityLabel: `${job.fileName} result report`, details: { rows: rows.length, format: 'csv' } });
  return { data: Buffer.from('﻿' + stringify([header, ...lines])), name: `${job.fileName.replace(/\.[^.]+$/, '')}-result.csv` };
}

/** FR-IMP-12: row reports stay downloadable for the configured months (12 by default), then the file and rows are purged; the log entry stays. */
export async function purgeExpiredImportReports(now = new Date()) {
  const s = await getSettings();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - s.importReportRetentionMonths);
  const jobs = await prisma.importJob.findMany({ where: { createdAt: { lt: cutoff }, reportPurgedAt: null, status: { in: ['COMMITTED', 'FAILED', 'CANCELLED'] } }, select: { id: true, storageKey: true } });
  for (const j of jobs) {
    await deleteObject(j.storageKey).catch(() => undefined);
    await prisma.importRow.deleteMany({ where: { jobId: j.id } });
    await prisma.importJob.update({ where: { id: j.id }, data: { reportPurgedAt: now } });
  }
  return { purged: jobs.length };
}
