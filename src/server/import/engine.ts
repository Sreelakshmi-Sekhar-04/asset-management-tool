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

export async function startImport(actor: Actor, p: { type: ImportType; mode: 'CREATE_ONLY' | 'CREATE_OR_UPDATE'; createMissing: boolean; fileName: string; data: Buffer }) {
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
  const job = await prisma.importJob.create({ data: { type: p.type, mode: p.mode, createMissing: p.createMissing, fileName: p.fileName.slice(0, 200), storageKey: key, createdById: actor.id, createdByName: actor.name } });
  await enqueue('import.validate', { jobId: job.id });
  await audit(prisma, actor, { action: 'IMPORT_UPLOADED', entityType: 'Import', entityId: job.id, entityLabel: job.fileName, details: { type: p.type, mode: p.mode, createMissing: p.createMissing, bytes: p.data.length } });
  return job;
}

/**
 * The rows to check. The first dry run reads the uploaded file; after that the stored rows are the
 * source, because they carry the corrections made in the preview, and those are what get imported.
 */
async function sourceRows(db: Db, job: ImportJob): Promise<ParsedRow[]> {
  if (job.validatedAt) {
    const stored = await db.importRow.findMany({ where: { jobId: job.id }, orderBy: { rowNumber: 'asc' }, select: { rowNumber: true, data: true } });
    if (stored.length) return stored.map((r) => ({ rowNumber: r.rowNumber, data: r.data as Record<string, string> }));
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

export async function confirmImport(actor: Actor, jobId: string, warningReason?: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Import');
  if (job.status !== 'VALIDATED') throw conflict(`This import is ${job.status.toLowerCase().replace('_', ' ')}; only a validated dry run can be committed.`);
  const counts = job.counts as Record<string, number>;
  if ((counts.CREATED ?? 0) + (counts.UPDATED ?? 0) + (counts.WARNING ?? 0) === 0) throw badRequest('Nothing to import: every row is a duplicate or rejected.');
  if ((counts.WARNING ?? 0) > 0 && !warningReason?.trim()) throw badRequest(`${counts.WARNING} row(s) carry duplicate warnings. Give a reason to accept them.`, [{ field: 'warningReason', message: 'Required' }]);
  const n = await prisma.importJob.updateMany({ where: { id: jobId, status: 'VALIDATED' }, data: { status: 'COMMIT_QUEUED', warningReason: warningReason ?? null, committedById: actor.id, processedRows: 0 } });
  if (!n.count) throw conflict('This import has already been confirmed.');
  await enqueue('import.commit', { jobId });
  await audit(prisma, actor, { action: 'IMPORT_CONFIRMED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: { warningReason } });
  return { ok: true };
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
export const EDITABLE_ASSET_FIELDS = ['serialnumber', 'make', 'model', 'category', 'legacytag', 'ipaddress', 'hostname', 'macaddress', 'location', 'holderemployeeid', 'purchasedate', 'purchasecost', 'vendor', 'warrantyend', 'condition', 'remarks'] as const;

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

/** Worker step 2: re-validate against the current database, then apply atomically. */
export async function runCommit(jobId: string) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job || (job.status !== 'COMMIT_QUEUED' && job.status !== 'COMMITTING')) return;
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTING', processedRows: 0 } });
  const actor = await actorForUser(prisma, job.committedById ?? job.createdById);
  try {
    const v = await validate(job);
    const stored = new Map((await prisma.importRow.findMany({ where: { jobId }, select: { rowNumber: true, outcome: true } })).map((r) => [r.rowNumber, r.outcome]));
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
    const counts = countOutcomes(v.rows);
    await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTED', committedAt: new Date(), processedRows: v.rows.length, counts } });
    if (afterCommit) await (afterCommit as () => Promise<void>)();
    await audit(prisma, actor, { action: 'IMPORT_COMMITTED', entityType: 'Import', entityId: jobId, entityLabel: job.fileName, details: { type: job.type, mode: job.mode, ...counts, locationsCreated: job.locationsToCreate } });
    await notifyUsers(prisma, [job.createdById], { type: 'IMPORT_COMPLETED', title: `Import committed: ${job.fileName}`, body: `${counts.CREATED} created, ${counts.UPDATED} updated, ${counts.WARNING} with warnings, ${counts.UNCHANGED} duplicate, ${counts.REJECTED} rejected.`, link: `/imports/${jobId}`, eventKey: `import:${jobId}:committed` });
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
  return job;
}

export async function importRows(actor: Actor, id: string, p: { outcome?: string; skip: number; take: number }) {
  const job = await getImport(actor, id);
  const where: Prisma.ImportRowWhereInput = { jobId: id, ...(p.outcome ? { outcome: p.outcome as RowResult<unknown>['outcome'] } : {}) };
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
    assetIds.length ? prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, assetCode: true, status: true } }) : [],
  ]);
  const empName = new Map(emps.map((e) => [e.employeeCode.toLowerCase(), e.name]));
  const byId = new Map(assets.map((a) => [a.id, a]));
  return rows.map((r) => {
    const code = String((r.data as Record<string, string>).holderemployeeid ?? '').trim();
    const a = byId.get(r.resultId ?? '') ?? byId.get(r.matchedId ?? '') ?? null;
    return { ...r, view: { holderName: code ? empName.get(code.toLowerCase()) ?? null : null, asset: a } };
  });
}

/** FR-IMP-05: every row with its original row number, outcome and reason, as CSV. */
export async function importReportCsv(actor: Actor, id: string) {
  const job = await getImport(actor, id);
  if (job.reportPurgedAt) throw conflict(`The row report for ${job.fileName} was removed on ${job.reportPurgedAt.toISOString().slice(0, 10)} under the import retention setting. The import log entry and its counts remain.`);
  const rows = await prisma.importRow.findMany({ where: { jobId: id }, orderBy: { rowNumber: 'asc' } });
  const cols = COLUMNS[job.type].map((c) => c.key);
  const header = ['Row', 'Outcome', 'Reason', 'Result ID', ...COLUMNS[job.type].map((c) => c.header)];
  const outcomeLabel = (o: string) => (o === 'UNCHANGED' ? 'Duplicate' : o[0] + o.slice(1).toLowerCase());
  const lines = rows.map((r) => [r.rowNumber, outcomeLabel(r.outcome), r.messages.join(' | '), r.resultCode ?? '', ...cols.map((k) => (r.data as Record<string, string>)[k] ?? '')]);
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
