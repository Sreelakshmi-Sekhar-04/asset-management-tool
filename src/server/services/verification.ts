import { z } from 'zod';
import type { Prisma, VerificationTaskStatus } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { extractAssetCode } from '@/lib/asset-code';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { dateOnly, daysBetween, fmtDateOnly, todayIST } from '@/lib/format';
import type { Actor } from '../actor';
import { SYSTEM_ACTOR } from '../actor';
import { audit, auditMany } from '../audit';
import { inScopePath, locationScope } from '../scope';
import { branchUserIdsFor, itUserIds, notifyUsers } from '../notify';
import { getSettings } from '../settings';
import { createAssetInput, enforceDuplicates, findDuplicates, insertAsset } from './assets';
import { holderColumns, holderOf, recordMovement, switchAssignment, validateHolder } from './movement';

export const campaignInput = z.object({
  name: z.string().trim().min(1).max(160),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  scope: z.enum(['ALL', 'REGIONS', 'BRANCHES']),
  scopeLocationIds: z.array(z.string()).default([]),
  recurrenceQuarterly: z.boolean().default(false),
});

function addMonths(d: Date, m: number) {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}

async function branchesInScope(db: Db, scope: string, ids: string[]) {
  if (scope === 'ALL') return db.location.findMany({ where: { type: 'BRANCH', active: true }, orderBy: { namePath: 'asc' } });
  if (!ids.length) throw badRequest('Choose at least one region or branch.');
  const nodes = await db.location.findMany({ where: { id: { in: ids } } });
  if (scope === 'BRANCHES') return nodes.filter((n) => n.active);
  return db.location.findMany({ where: { type: 'BRANCH', active: true, OR: nodes.map((n) => ({ idPath: { startsWith: n.idPath } })) }, orderBy: { namePath: 'asc' } });
}

/** FR-VER-01: one task per branch, each holding a snapshot of that branch's assets at creation time. */
export async function createCampaign(actor: Actor, input: unknown, opts: { parentId?: string } = {}) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Verification campaigns are created by IT.');
  const data = campaignInput.parse(input);
  if (data.dueDate < todayIST()) throw badRequest('The due date cannot be in the past.');
  return tx(async (t) => {
    const branches = await branchesInScope(t, data.scope, data.scopeLocationIds);
    if (!branches.length) throw badRequest('The chosen scope contains no active branches.');
    const due = dateOnly(data.dueDate);
    const campaign = await t.verificationCampaign.create({
      data: { name: data.name, dueDate: due, scope: data.scope, scopeLocationIds: data.scopeLocationIds, recurrenceQuarterly: data.recurrenceQuarterly, nextRunAt: data.recurrenceQuarterly ? addMonths(dateOnly(todayIST()), 3) : null, parentId: opts.parentId ?? null, createdById: actor.id === 'system' ? 'system' : actor.id },
    });
    let lineTotal = 0;
    for (const b of branches) {
      const task = await t.verificationTask.create({ data: { campaignId: campaign.id, locationId: b.id } });
      const assets = await t.asset.findMany({
        where: { status: { not: 'RETIRED' }, location: { idPath: { startsWith: b.idPath } } },
        include: { category: { select: { name: true } }, location: { select: { namePath: true } }, holderEmployee: { select: { name: true, employeeCode: true } }, holderDepartment: { select: { name: true } }, transferLines: { where: { status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] } }, select: { transfer: { select: { transferNo: true, toLocation: { select: { namePath: true } } } } } } },
      });
      for (let i = 0; i < assets.length; i += 5000) {
        await t.verificationLine.createMany({
          data: assets.slice(i, i + 5000).map((a) => ({
            taskId: task.id, assetId: a.id, assetCode: a.assetCode, inTransit: a.transferLines.length > 0,
            snapshot: { category: a.category.name, make: a.make, model: a.model, serialNumber: a.serialNumber, hostname: a.hostname, ipAddress: a.ipAddress, legacyTag: a.legacyTag, status: a.status, location: a.location?.namePath, holder: a.holderEmployee ? `${a.holderEmployee.name} (${a.holderEmployee.employeeCode})` : a.holderDepartment?.name ?? null, transfer: a.transferLines[0] ? `${a.transferLines[0].transfer.transferNo} → ${a.transferLines[0].transfer.toLocation.namePath}` : null },
          })),
        });
      }
      lineTotal += assets.length;
      await notifyUsers(t, await branchUserIdsFor(t, b.id), { type: 'VERIFICATION', title: `Verification task: ${data.name}`, body: `Please verify the ${assets.length} asset(s) at ${b.namePath} by ${fmtDateOnly(due)}.`, link: `/verification/tasks/${task.id}`, eventKey: `verification:${task.id}:assigned` });
    }
    await audit(t, actor, { action: 'VERIFICATION_CAMPAIGN_CREATED', entityType: 'VerificationCampaign', entityId: campaign.id, entityLabel: campaign.name, details: { scope: data.scope, branches: branches.length, lines: lineTotal, dueDate: data.dueDate, quarterly: data.recurrenceQuarterly } });
    return { campaign, tasks: branches.length, lines: lineTotal };
  }, { timeoutMs: 300_000 });
}

export async function closeCampaign(actor: Actor, id: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  const c = await prisma.verificationCampaign.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), recurrenceQuarterly: false, nextRunAt: null } });
  await audit(prisma, actor, { action: 'VERIFICATION_CAMPAIGN_CLOSED', entityType: 'VerificationCampaign', entityId: id, entityLabel: c.name });
  return c;
}

// ───────────── Task access ─────────────

async function scopedTask(actor: Actor, id: string, db: Db = prisma) {
  const task = await db.verificationTask.findUnique({ where: { id }, include: { location: true, campaign: true } });
  if (!task || !inScopePath(actor, task.location.idPath)) throw notFound('Verification task');
  return task;
}

function assertEditable(actor: Actor, status: VerificationTaskStatus) {
  if (status === 'SUBMITTED' || status === 'SIGNED_OFF') throw conflict(actor.role === 'BRANCH_USER' ? 'This task has been submitted and is locked. Only IT can reopen it.' : 'This task is submitted; reopen it before editing.');
}

export async function listTasks(actor: Actor, p: { campaignId?: string; status?: string; skip: number; take: number }) {
  const where: Prisma.VerificationTaskWhereInput = {
    location: locationScope(actor),
    ...(p.campaignId ? { campaignId: p.campaignId } : {}),
    ...(p.status ? { status: p.status as VerificationTaskStatus } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.verificationTask.findMany({ where, include: { location: { select: { namePath: true } }, campaign: { select: { id: true, name: true, dueDate: true, status: true } } }, orderBy: [{ campaign: { dueDate: 'desc' } }, { location: { namePath: 'asc' } }], skip: p.skip, take: p.take }),
    prisma.verificationTask.count({ where }),
  ]);
  const stats = await taskStats(rows.map((r) => r.id));
  const today = dateOnly(todayIST());
  return { rows: rows.map((r) => ({ ...r, stats: stats(r.id), overdue: r.campaign.dueDate < today && (r.status === 'NOT_STARTED' || r.status === 'IN_PROGRESS') })), total };
}

async function taskStats(ids: string[]) {
  const lines = await prisma.verificationLine.groupBy({ by: ['taskId', 'result', 'inTransit'], where: { taskId: { in: ids } }, _count: true });
  const unl = await prisma.verificationUnlisted.groupBy({ by: ['taskId'], where: { taskId: { in: ids } }, _count: true });
  const pendingReview = await prisma.verificationLine.groupBy({ by: ['taskId'], where: { taskId: { in: ids }, result: { in: ['MISSING', 'WRONG_DETAILS'] }, reviewStatus: null }, _count: true });
  const pendingUnl = await prisma.verificationUnlisted.groupBy({ by: ['taskId'], where: { taskId: { in: ids }, reviewStatus: 'PENDING' }, _count: true });
  return (id: string) => {
    const s = { total: 0, inTransit: 0, present: 0, missing: 0, wrong: 0, unmarked: 0, unlisted: 0, pendingReview: 0 };
    for (const l of lines.filter((x) => x.taskId === id)) {
      if (l.inTransit) { s.inTransit += l._count; continue; }
      s.total += l._count;
      if (l.result === 'PRESENT') s.present += l._count; else if (l.result === 'MISSING') s.missing += l._count; else if (l.result === 'WRONG_DETAILS') s.wrong += l._count; else s.unmarked += l._count;
    }
    s.unlisted = unl.find((u) => u.taskId === id)?._count ?? 0;
    s.pendingReview = (pendingReview.find((u) => u.taskId === id)?._count ?? 0) + (pendingUnl.find((u) => u.taskId === id)?._count ?? 0);
    return { ...s, discrepancies: s.missing + s.wrong + s.unlisted };
  };
}

export async function getTask(actor: Actor, id: string) {
  const task = await scopedTask(actor, id);
  const stats = (await taskStats([id]))(id);
  const unlisted = await prisma.verificationUnlisted.findMany({ where: { taskId: id }, orderBy: { createdAt: 'asc' } });
  const cats = await prisma.assetCategory.findMany({ where: { id: { in: unlisted.map((u) => u.categoryId) } }, select: { id: true, name: true } });
  const cm = new Map(cats.map((c) => [c.id, c.name]));
  return { ...task, stats, unlisted: unlisted.map((u) => ({ ...u, category: cm.get(u.categoryId) })), overdue: task.campaign.dueDate < dateOnly(todayIST()) && (task.status === 'NOT_STARTED' || task.status === 'IN_PROGRESS'), canEdit: task.status === 'NOT_STARTED' || task.status === 'IN_PROGRESS', canReview: actor.role !== 'BRANCH_USER' };
}

export async function listTaskLines(actor: Actor, id: string, p: { search?: string; result?: string; inTransit?: boolean; skip: number; take: number }) {
  await scopedTask(actor, id);
  const where: Prisma.VerificationLineWhereInput = {
    taskId: id,
    inTransit: p.inTransit ?? false,
    ...(p.search ? { OR: [{ assetCode: { contains: p.search, mode: 'insensitive' } }, { asset: { serialNumber: { contains: p.search, mode: 'insensitive' } } }, { asset: { hostname: { contains: p.search, mode: 'insensitive' } } }] } : {}),
    ...(p.result === 'UNMARKED' ? { result: null } : p.result ? { result: p.result as 'PRESENT' } : {}),
  };
  const [rows, total] = await Promise.all([prisma.verificationLine.findMany({ where, orderBy: { assetCode: 'asc' }, skip: p.skip, take: p.take }), prisma.verificationLine.count({ where })]);
  return { rows, total };
}

// ───────────── Checklist (FR-VER-02..04) ─────────────

export const markInput = z.object({
  lines: z.array(z.object({
    lineId: z.string(),
    result: z.enum(['PRESENT', 'MISSING', 'WRONG_DETAILS']),
    correctedHostname: z.string().trim().max(120).nullable().optional(),
    correctedIp: z.string().trim().max(60).nullable().optional(),
    correctedHolderEmployeeId: z.string().nullable().optional(),
    correctedRemarks: z.string().trim().max(1000).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })).min(1).max(20_000),
});

export async function markLines(actor: Actor, taskId: string, input: unknown) {
  const data = markInput.parse(input);
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    assertEditable(actor, task.status);
    for (const l of data.lines) {
      if (l.result === 'WRONG_DETAILS' && !l.correctedHostname && !l.correctedIp && !l.correctedHolderEmployeeId && !l.correctedRemarks)
        throw badRequest('For "Wrong details" supply at least one corrected value (hostname, IP, holder or remarks).');
      if (l.correctedIp) { const { isIP } = await import('node:net'); if (!isIP(l.correctedIp)) throw badRequest(`"${l.correctedIp}" is not a valid IP address.`); }
      const n = await t.verificationLine.updateMany({
        where: { id: l.lineId, taskId, inTransit: false },
        data: { result: l.result, correctedHostname: l.result === 'WRONG_DETAILS' ? l.correctedHostname ?? null : null, correctedIp: l.result === 'WRONG_DETAILS' ? l.correctedIp ?? null : null, correctedHolderEmployeeId: l.result === 'WRONG_DETAILS' ? l.correctedHolderEmployeeId ?? null : null, correctedRemarks: l.result === 'WRONG_DETAILS' ? l.correctedRemarks ?? null : null, note: l.note ?? null, markedAt: new Date(), markedById: actor.id },
      });
      if (n.count !== 1) throw badRequest('A line does not belong to this checklist or is in transit.');
    }
    if (task.status === 'NOT_STARTED') await t.verificationTask.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
    await audit(t, actor, { action: 'VERIFICATION_MARKED', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: { lines: data.lines.length, results: data.lines.reduce((a, l) => ({ ...a, [l.result]: ((a as Record<string, number>)[l.result] ?? 0) + 1 }), {}), onBehalf: actor.role !== 'BRANCH_USER' }, locationIds: [task.locationId] });
    return { marked: data.lines.length };
  });
}

/** FR-VER-03: mark every *unmarked* line present, so per-row overrides survive. */
export async function markAllPresent(actor: Actor, taskId: string) {
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    assertEditable(actor, task.status);
    const n = await t.verificationLine.updateMany({ where: { taskId, inTransit: false, result: null }, data: { result: 'PRESENT', markedAt: new Date(), markedById: actor.id } });
    if (task.status === 'NOT_STARTED') await t.verificationTask.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
    await audit(t, actor, { action: 'VERIFICATION_MARK_ALL_PRESENT', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: { lines: n.count }, locationIds: [task.locationId] });
    return { marked: n.count };
  });
}

/** Scan or type an Asset ID to tick it off; unknown scans are reported, never ignored. */
export async function scanLine(actor: Actor, taskId: string, code: string) {
  const task = await scopedTask(actor, taskId);
  assertEditable(actor, task.status);
  const c = extractAssetCode(code).toUpperCase();
  const line = await prisma.verificationLine.findFirst({ where: { taskId, OR: [{ assetCode: c }, { asset: { serialNormalized: c.toLowerCase() } }, { asset: { legacyTagNormalized: c.toLowerCase() } }] } });
  if (!line) throw notFound(`"${code}" is not on this checklist. If the asset is physically here, add it as an unlisted asset. Asset`);
  if (line.inTransit) throw conflict(`${line.assetCode} is in an open transfer and is excluded from this checklist.`);
  await markLines(actor, taskId, { lines: [{ lineId: line.id, result: 'PRESENT' }] });
  return { lineId: line.id, assetCode: line.assetCode };
}

export const unlistedInput = z.object({
  categoryId: z.string().min(1), make: z.string().trim().min(1).max(120), model: z.string().trim().min(1).max(160),
  serialNumber: z.string().trim().max(120).nullable().optional(), hostname: z.string().trim().max(120).nullable().optional(),
  ipAddress: z.string().trim().max(60).nullable().optional(), legacyTag: z.string().trim().max(80).nullable().optional(), remarks: z.string().trim().max(1000).nullable().optional(),
});

export async function addUnlisted(actor: Actor, taskId: string, input: unknown) {
  const data = unlistedInput.parse(input);
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    assertEditable(actor, task.status);
    const cat = await t.assetCategory.findUnique({ where: { id: data.categoryId } });
    if (!cat || !cat.active) throw badRequest('Choose an active category.');
    if (cat.serialRequired && !data.serialNumber) throw badRequest(`Serial number is required for category ${cat.name}.`);
    const hits = await findDuplicates(t, data);
    const u = await t.verificationUnlisted.create({ data: { taskId, ...data, serialNumber: data.serialNumber || null, hostname: data.hostname || null, ipAddress: data.ipAddress || null, legacyTag: data.legacyTag || null, remarks: data.remarks || null, addedById: actor.id } });
    if (task.status === 'NOT_STARTED') await t.verificationTask.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
    await audit(t, actor, { action: 'VERIFICATION_UNLISTED_ADDED', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: { ...data, possibleDuplicates: hits.map((h) => `${h.key}:${h.match.assetCode}`) }, locationIds: [task.locationId] });
    return { unlisted: u, possibleDuplicates: hits };
  });
}

export async function removeUnlisted(actor: Actor, taskId: string, unlistedId: string) {
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    assertEditable(actor, task.status);
    const n = await t.verificationUnlisted.deleteMany({ where: { id: unlistedId, taskId, reviewStatus: 'PENDING' } });
    if (!n.count) throw notFound('Unlisted entry');
    await audit(t, actor, { action: 'VERIFICATION_UNLISTED_REMOVED', entityType: 'VerificationTask', entityId: taskId, details: { unlistedId }, locationIds: [task.locationId] });
    return { ok: true };
  });
}

export async function submitTask(actor: Actor, taskId: string) {
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    assertEditable(actor, task.status);
    const unmarked = await t.verificationLine.count({ where: { taskId, inTransit: false, result: null } });
    if (unmarked) throw badRequest(`${unmarked} asset(s) are not yet marked. Mark every asset Present, Missing or Wrong details before submitting.`);
    const u = await t.verificationTask.update({ where: { id: taskId }, data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: actor.id, submittedByName: actor.name } });
    const stats = (await taskStats([taskId]))(taskId);
    await audit(t, actor, { action: 'VERIFICATION_SUBMITTED', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: stats, locationIds: [task.locationId] });
    await notifyUsers(t, await itUserIds(t), { type: 'VERIFICATION', title: `Verification submitted: ${task.location.namePath}`, body: `${task.campaign.name}: ${stats.present} present, ${stats.missing} missing, ${stats.wrong} wrong details, ${stats.unlisted} unlisted.`, link: `/verification/tasks/${taskId}`, eventKey: `verification:${taskId}:submitted:${Date.now()}` });
    return u;
  });
}

export async function reopenTask(actor: Actor, taskId: string, reason: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Only IT can reopen a submitted task.');
  if (!reason?.trim()) throw badRequest('A reason is required.');
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    if (task.status !== 'SUBMITTED') throw conflict('Only a submitted (not signed-off) task can be reopened.');
    await t.verificationTask.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS', submittedAt: null } });
    await audit(t, actor, { action: 'VERIFICATION_REOPENED', entityType: 'VerificationTask', entityId: taskId, details: { reason }, locationIds: [task.locationId] });
    await notifyUsers(t, await branchUserIdsFor(t, task.locationId), { type: 'VERIFICATION', title: `Verification reopened: ${task.campaign.name}`, body: `IT reopened your verification task: ${reason}`, link: `/verification/tasks/${taskId}`, eventKey: `verification:${taskId}:reopen:${Date.now()}` });
    return { ok: true };
  });
}

// ───────────── IT review (FR-VER-05) ─────────────

export const reviewInput = z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']), note: z.string().trim().max(1000).optional(), duplicateReason: z.string().trim().max(500).optional() });

export async function reviewLine(actor: Actor, taskId: string, lineId: string, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Discrepancies are reviewed by IT.');
  const data = reviewInput.parse(input);
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    if (task.status !== 'SUBMITTED') throw conflict('Discrepancies are reviewed after the branch submits the task.');
    const line = await t.verificationLine.findFirst({ where: { id: lineId, taskId }, include: { asset: true } });
    if (!line) throw notFound('Line');
    if (line.result !== 'MISSING' && line.result !== 'WRONG_DETAILS') throw badRequest('Only Missing and Wrong-details lines need review.');
    if (line.reviewStatus) throw conflict('This discrepancy has already been reviewed.');
    const asset = line.asset;
    const applied: Record<string, unknown> = {};
    if (data.decision === 'ACCEPTED') {
      if (asset.status === 'RETIRED') throw conflict(`Asset ${asset.assetCode} has been retired since the snapshot; reject this discrepancy instead.`);
      if (line.result === 'MISSING') {
        await t.asset.update({ where: { id: asset.id }, data: { flagMissing: true } });
        applied.flagMissing = true;
      } else {
        const changes: Record<string, unknown> = {};
        if (line.correctedHostname && line.correctedHostname !== asset.hostname) changes.hostname = line.correctedHostname;
        if (line.correctedIp && line.correctedIp !== asset.ipAddress) changes.ipAddress = line.correctedIp;
        if (line.correctedRemarks) changes.remarks = [asset.remarks, `Verification: ${line.correctedRemarks}`].filter(Boolean).join('\n');
        const hits = await findDuplicates(t, { hostname: changes.hostname as string, ipAddress: changes.ipAddress as string }, asset.id);
        const warns = enforceDuplicates(hits, data.duplicateReason);
        if (Object.keys(changes).length) {
          const fs = { ...(asset.fieldSources as Record<string, string>) };
          for (const k of Object.keys(changes)) fs[k] = 'verification';
          await t.asset.update({ where: { id: asset.id }, data: { ...changes, fieldSources: fs, updatedById: actor.id } });
          await audit(t, actor, { action: 'ASSET_UPDATED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, before: { hostname: asset.hostname, ipAddress: asset.ipAddress, remarks: asset.remarks }, after: changes, details: { source: 'verification', task: taskId, duplicateReason: warns.length ? data.duplicateReason : undefined }, locationIds: [asset.locationId] });
          if (warns.length) await t.duplicateFlag.createMany({ data: warns.map((w) => ({ assetId: asset.id, matchedAssetId: w.match.id, key: w.key, value: w.value, reason: data.duplicateReason!, createdById: actor.id })) }).then(() => t.asset.updateMany({ where: { id: { in: [asset.id, ...warns.map((w) => w.match.id)] } }, data: { flagDuplicateSuspect: true } }));
          Object.assign(applied, changes);
        }
        if (line.correctedHolderEmployeeId && line.correctedHolderEmployeeId !== asset.holderEmployeeId) {
          const locked = await t.transferLine.count({ where: { assetId: asset.id, status: { in: ['PENDING_APPROVAL', 'IN_TRANSIT'] } } });
          if (locked) throw conflict(`Asset ${asset.assetCode} is in an open transfer; the holder correction cannot be applied now.`);
          const holder = { type: 'EMPLOYEE' as const, id: line.correctedHolderEmployeeId };
          await validateHolder(t, actor, holder);
          const status = asset.status === 'UNDER_REPAIR' ? 'UNDER_REPAIR' : 'ASSIGNED';
          await t.asset.update({ where: { id: asset.id }, data: { status, ...holderColumns(holder) } });
          await switchAssignment(t, actor, asset.id, holder, 'VERIFICATION');
          await recordMovement(t, actor, 'CORRECTION', asset, { id: asset.id, status, locationId: asset.locationId, holder }, { reason: `Verification correction (${task.campaign.name})`, isCorrection: true });
          applied.holder = holder;
          void holderOf;
        }
      }
    }
    await t.verificationLine.update({ where: { id: lineId }, data: { reviewStatus: data.decision, reviewedById: actor.id, reviewedAt: new Date(), reviewNote: data.note } });
    await audit(t, actor, { action: data.decision === 'ACCEPTED' ? 'VERIFICATION_DISCREPANCY_ACCEPTED' : 'VERIFICATION_DISCREPANCY_REJECTED', entityType: 'Asset', entityId: asset.id, entityLabel: asset.assetCode, details: { result: line.result, applied, note: data.note, task: `${task.campaign.name} — ${task.location.namePath}` }, locationIds: [task.locationId] });
    return { ok: true, applied };
  });
}

export async function reviewUnlisted(actor: Actor, taskId: string, unlistedId: string, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Unlisted assets are reviewed by IT.');
  const data = reviewInput.parse(input);
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    if (task.status !== 'SUBMITTED') throw conflict('Unlisted assets are reviewed after the branch submits the task.');
    const u = await t.verificationUnlisted.findFirst({ where: { id: unlistedId, taskId } });
    if (!u) throw notFound('Unlisted entry');
    if (u.reviewStatus !== 'PENDING') throw conflict('This entry has already been reviewed.');
    let assetCode: string | null = null;
    if (data.decision === 'ACCEPTED') {
      const input2 = createAssetInput.parse({ categoryId: u.categoryId, make: u.make, model: u.model, serialNumber: u.serialNumber, hostname: u.hostname, ipAddress: u.ipAddress, legacyTag: u.legacyTag, remarks: u.remarks, locationId: task.locationId, duplicateReason: data.duplicateReason });
      const warns = enforceDuplicates(await findDuplicates(t, input2), data.duplicateReason);
      const asset = await insertAsset(t, actor, input2, 'verification', warns, actor.name);
      await t.verificationUnlisted.update({ where: { id: unlistedId }, data: { createdAssetId: asset.id } });
      assetCode = asset.assetCode;
    }
    await t.verificationUnlisted.update({ where: { id: unlistedId }, data: { reviewStatus: data.decision, reviewedById: actor.id, reviewedAt: new Date(), reviewNote: data.note } });
    await audit(t, actor, { action: data.decision === 'ACCEPTED' ? 'VERIFICATION_UNLISTED_ACCEPTED' : 'VERIFICATION_UNLISTED_REJECTED', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: { make: u.make, model: u.model, serial: u.serialNumber, createdAsset: assetCode, note: data.note }, locationIds: [task.locationId] });
    return { ok: true, assetCode };
  });
}

export async function signOff(actor: Actor, taskId: string, note?: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Sign-off is an IT function.');
  return tx(async (t) => {
    const task = await scopedTask(actor, taskId, t);
    if (task.status !== 'SUBMITTED') throw conflict('Only a submitted task can be signed off.');
    const pending = (await t.verificationLine.count({ where: { taskId, result: { in: ['MISSING', 'WRONG_DETAILS'] }, reviewStatus: null } })) + (await t.verificationUnlisted.count({ where: { taskId, reviewStatus: 'PENDING' } }));
    if (pending) throw conflict(`${pending} discrepancy(ies) still need review before sign-off.`);
    const u = await t.verificationTask.update({ where: { id: taskId }, data: { status: 'SIGNED_OFF', signedOffAt: new Date(), signedOffById: actor.id, signedOffByName: actor.name, signOffNote: note ?? null } });
    // A Present result is fresh evidence the asset is there: clear any Missing flag it carried.
    const present = await t.verificationLine.findMany({ where: { taskId, result: 'PRESENT' }, select: { assetId: true, assetCode: true } });
    const flagged = await t.asset.findMany({ where: { id: { in: present.map((p) => p.assetId) }, flagMissing: true }, select: { id: true, assetCode: true, locationId: true } });
    if (flagged.length) {
      await t.asset.updateMany({ where: { id: { in: flagged.map((f) => f.id) } }, data: { flagMissing: false } });
      await auditMany(t, actor, flagged.map((f) => ({ action: 'ASSET_FLAG_CLEARED', entityType: 'Asset', entityId: f.id, entityLabel: f.assetCode, details: { flag: 'MISSING', reason: 'Verified present' }, locationIds: [f.locationId] })));
    }
    await audit(t, actor, { action: 'VERIFICATION_SIGNED_OFF', entityType: 'VerificationTask', entityId: taskId, entityLabel: `${task.campaign.name} — ${task.location.namePath}`, details: { note }, locationIds: [task.locationId] });
    return u;
  });
}

// ───────────── Reporting (FR-VER-08, 09) ─────────────

export async function campaignDashboard(actor: Actor, campaignId: string) {
  const c = await prisma.verificationCampaign.findUnique({ where: { id: campaignId } });
  if (!c) throw notFound('Campaign');
  const { rows } = await listTasks(actor, { campaignId, skip: 0, take: 10_000 });
  if (actor.role === 'BRANCH_USER' && !rows.length) throw notFound('Campaign');
  const buckets = { notStarted: 0, inProgress: 0, submitted: 0, signedOff: 0, overdue: 0 };
  for (const r of rows) {
    if (r.overdue) buckets.overdue++;
    if (r.status === 'NOT_STARTED') buckets.notStarted++; else if (r.status === 'IN_PROGRESS') buckets.inProgress++; else if (r.status === 'SUBMITTED') buckets.submitted++; else buckets.signedOff++;
  }
  return { campaign: c, buckets, tasks: rows };
}

export async function listCampaigns(actor: Actor) {
  const campaigns = await prisma.verificationCampaign.findMany({ orderBy: { createdAt: 'desc' }, include: { tasks: { select: { status: true, location: { select: { idPath: true } } } } } });
  const today = dateOnly(todayIST());
  return campaigns
    .map((c) => {
      const tasks = c.tasks.filter((t) => inScopePath(actor, t.location.idPath));
      const count = (s: string) => tasks.filter((t) => t.status === s).length;
      return { id: c.id, name: c.name, dueDate: c.dueDate, scope: c.scope, status: c.status, recurrenceQuarterly: c.recurrenceQuarterly, nextRunAt: c.nextRunAt, createdAt: c.createdAt, tasks: tasks.length, notStarted: count('NOT_STARTED'), inProgress: count('IN_PROGRESS'), submitted: count('SUBMITTED'), signedOff: count('SIGNED_OFF'), overdue: c.dueDate < today ? count('NOT_STARTED') + count('IN_PROGRESS') : 0 };
    })
    .filter((c) => actor.role !== 'BRANCH_USER' || c.tasks > 0);
}

export async function discrepancies(actor: Actor, p: { campaignId?: string; review?: string; skip: number; take: number }) {
  const where: Prisma.VerificationLineWhereInput = {
    result: { in: ['MISSING', 'WRONG_DETAILS'] },
    task: { location: locationScope(actor), ...(p.campaignId ? { campaignId: p.campaignId } : {}) },
    ...(p.review === 'PENDING' ? { reviewStatus: null } : p.review ? { reviewStatus: p.review as 'ACCEPTED' } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.verificationLine.findMany({ where, include: { task: { select: { id: true, status: true, location: { select: { namePath: true } }, campaign: { select: { name: true } } } } }, orderBy: [{ task: { location: { namePath: 'asc' } } }, { assetCode: 'asc' }], skip: p.skip, take: p.take }),
    prisma.verificationLine.count({ where }),
  ]);
  const unlisted = await prisma.verificationUnlisted.findMany({ where: { task: { location: locationScope(actor), ...(p.campaignId ? { campaignId: p.campaignId } : {}) }, ...(p.review === 'PENDING' ? { reviewStatus: 'PENDING' } : p.review ? { reviewStatus: p.review as 'ACCEPTED' } : {}) }, include: { task: { select: { id: true, location: { select: { namePath: true } }, campaign: { select: { name: true } } } } }, take: 2000 });
  return { rows, total, unlisted };
}

export async function verifiedStock(actor: Actor, taskId: string) {
  const task = await scopedTask(actor, taskId);
  const lines = await prisma.verificationLine.findMany({ where: { taskId, result: 'PRESENT' }, orderBy: { assetCode: 'asc' } });
  return lines.map((l) => {
    const s = l.snapshot as Record<string, string | null>;
    return { assetCode: l.assetCode, category: s.category, make: s.make, model: s.model, serialNumber: s.serialNumber, hostname: s.hostname, lastVerified: l.markedAt, branch: task.location.namePath, campaign: task.campaign.name, signedOffBy: task.signedOffByName, signedOffAt: task.signedOffAt };
  });
}

// ───────────── Scheduler (FR-VER-07) ─────────────

export async function runVerificationScheduler(asOf: string = todayIST()) {
  const today = dateOnly(asOf);
  const s = await getSettings();
  let reminders = 0, created = 0;
  // Recurring campaigns: create the next quarter's campaign when due.
  const due = await prisma.verificationCampaign.findMany({ where: { recurrenceQuarterly: true, status: 'ACTIVE', nextRunAt: { lte: today } } });
  for (const c of due) {
    const key = `campaign-recur:${c.id}:${c.nextRunAt?.toISOString().slice(0, 10)}`;
    const claimed = await prisma.scheduledEvent.createMany({ data: [{ key }], skipDuplicates: true });
    if (!claimed.count) continue;
    const nextDue = addMonths(c.dueDate, 3);
    const q = Math.floor(nextDue.getUTCMonth() / 3) + 1;
    await createCampaign(SYSTEM_ACTOR, { name: `${c.name.replace(/ — Q\d \d{4}$/, '')} — Q${q} ${nextDue.getUTCFullYear()}`, dueDate: nextDue.toISOString().slice(0, 10) < asOf ? addMonths(today, 1).toISOString().slice(0, 10) : nextDue.toISOString().slice(0, 10), scope: c.scope, scopeLocationIds: c.scopeLocationIds, recurrenceQuarterly: true }, { parentId: c.id });
    await prisma.verificationCampaign.update({ where: { id: c.id }, data: { recurrenceQuarterly: false, nextRunAt: null } });
    created++;
  }
  // Reminders to branches that have not submitted: N days before due, then overdue.
  const open = await prisma.verificationTask.findMany({ where: { status: { in: ['NOT_STARTED', 'IN_PROGRESS'] }, campaign: { status: 'ACTIVE' } }, include: { campaign: true, location: true } });
  for (const t of open) {
    const days = daysBetween(today, t.campaign.dueDate);
    let tier: string | null = null;
    if (days < 0) tier = 'overdue';
    else { const match = [...s.verificationReminderDays].sort((a, b) => a - b).find((d) => days <= d); if (match !== undefined) tier = `due-${match}`; }
    if (!tier) continue;
    const key = `verification-reminder:${t.id}:${tier}`;
    const claimed = await prisma.scheduledEvent.createMany({ data: [{ key }], skipDuplicates: true });
    if (!claimed.count) continue;
    const title = tier === 'overdue' ? `Overdue verification: ${t.campaign.name}` : `Verification due in ${days} day(s): ${t.campaign.name}`;
    const body = `${t.location.namePath} has not yet submitted its verification (due ${fmtDateOnly(t.campaign.dueDate)}).`;
    await notifyUsers(prisma, await branchUserIdsFor(prisma, t.locationId), { type: 'VERIFICATION', title, body, link: `/verification/tasks/${t.id}`, eventKey: key });
    if (tier === 'overdue') await notifyUsers(prisma, await itUserIds(prisma), { type: 'VERIFICATION', title, body, link: `/verification/tasks/${t.id}`, eventKey: key });
    await audit(prisma, SYSTEM_ACTOR, { action: 'VERIFICATION_REMINDER_SENT', entityType: 'VerificationTask', entityId: t.id, entityLabel: `${t.campaign.name} — ${t.location.namePath}`, details: { tier }, locationIds: [t.locationId] });
    reminders++;
  }
  return { reminders, created };
}
