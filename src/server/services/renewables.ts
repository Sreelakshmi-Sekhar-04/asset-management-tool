import { z } from 'zod';
import { patchOf } from '@/lib/zod';
import type { Asset, Prisma, Renewable, RenewableType, ReminderPolicy, Role } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { dateOnly, daysBetween, fmtDateOnly, todayIST } from '@/lib/format';
import { RENEWABLE_TYPE_LABEL } from '@/lib/labels';
import type { Actor } from '../actor';
import { SYSTEM_ACTOR } from '../actor';
import { audit } from '../audit';
import { assetScope, getScopedAsset } from '../scope';
import { enqueueEmail, notifyUsers } from '../notify';

const WARRANTY_KEY = 'asset-warranty';
const optStr = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use YYYY-MM-DD');

export const renewableInput = z.object({
  assetId: z.string().min(1),
  type: z.enum(['WARRANTY', 'LICENCE', 'SUBSCRIPTION', 'AMC', 'CALIBRATION', 'INSURANCE', 'CERTIFICATE', 'OTHER']),
  label: z.string().trim().min(1).max(200),
  vendor: optStr(160),
  identifier: optStr(300),
  seats: z.number().int().positive().nullable().optional(),
  startDate: date.nullable().optional(),
  expiryDate: date,
  renewalTermMonths: z.number().int().positive().max(240).nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  ownerEmployeeId: z.string().nullable().optional(),
  critical: z.boolean().default(false),
});

// ───────────── Automatic warranty renewable (FR-REN-03) ─────────────

export async function syncWarrantyRenewable(t: Db, actor: Actor, asset: Pick<Asset, 'id' | 'assetCode' | 'make' | 'model' | 'vendor' | 'warrantyEnd' | 'purchaseDate'>, source = 'asset-warranty') {
  const existing = await t.renewable.findFirst({ where: { assetId: asset.id, type: 'WARRANTY', sourceKey: WARRANTY_KEY } });
  if (!asset.warrantyEnd) {
    if (existing && existing.status !== 'CANCELLED') {
      await t.renewable.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
      await t.renewalEvent.create({ data: { renewableId: existing.id, action: 'CANCELLED', oldExpiry: existing.expiryDate, note: 'Warranty end removed from asset', actorId: nid(actor) } });
    }
    return null;
  }
  if (!existing) {
    const r = await t.renewable.create({
      data: { assetId: asset.id, type: 'WARRANTY', label: `Warranty — ${asset.make} ${asset.model}`, vendor: asset.vendor, startDate: asset.purchaseDate, expiryDate: asset.warrantyEnd, source, sourceKey: WARRANTY_KEY, status: statusFor(asset.warrantyEnd) },
    });
    await t.renewalEvent.create({ data: { renewableId: r.id, action: 'CREATED', newExpiry: asset.warrantyEnd, note: `Created from asset ${asset.assetCode}`, actorId: nid(actor) } });
    await audit(t, actor, { action: 'RENEWABLE_CREATED', entityType: 'Renewable', entityId: r.id, entityLabel: r.label, details: { asset: asset.assetCode, expiry: fmtDateOnly(asset.warrantyEnd), source } });
    return r;
  }
  if (existing.expiryDate.getTime() === asset.warrantyEnd.getTime() && existing.status !== 'CANCELLED') return existing;
  const extended = asset.warrantyEnd > existing.expiryDate;
  const r = await t.renewable.update({
    where: { id: existing.id },
    data: { expiryDate: asset.warrantyEnd, status: statusFor(asset.warrantyEnd), source, ...(extended ? { cycle: { increment: 1 }, cycleStartedAt: new Date(), acknowledgedAt: null, acknowledgedById: null, snoozedUntil: null } : {}) },
  });
  await t.renewalEvent.create({ data: { renewableId: r.id, action: extended ? 'RENEWED' : 'UPDATED', oldExpiry: existing.expiryDate, newExpiry: asset.warrantyEnd, note: `Warranty end changed on ${asset.assetCode} (${source})`, actorId: nid(actor) } });
  await audit(t, actor, { action: 'RENEWABLE_UPDATED', entityType: 'Renewable', entityId: r.id, entityLabel: r.label, before: { expiry: fmtDateOnly(existing.expiryDate) }, after: { expiry: fmtDateOnly(asset.warrantyEnd) }, details: { source } });
  return r;
}

/** FR-REN-08 / FR-INT-07: expiry dates from integrations create or update renewables with a source flag. */
export async function upsertExpiryFromSource(t: Db, asset: Pick<Asset, 'id' | 'assetCode'>, e: { type: RenewableType; label: string; expiry: Date; vendor?: string | null; identifier?: string | null }, source: string) {
  const sourceKey = `${source}:${e.type}:${e.label.toLowerCase()}`;
  const existing = await t.renewable.findFirst({ where: { assetId: asset.id, type: e.type, sourceKey } });
  if (!existing) {
    const r = await t.renewable.create({ data: { assetId: asset.id, type: e.type, label: e.label, vendor: e.vendor ?? null, identifier: e.identifier ?? null, expiryDate: e.expiry, source, sourceKey, status: statusFor(e.expiry) } });
    await t.renewalEvent.create({ data: { renewableId: r.id, action: 'CREATED', newExpiry: e.expiry, note: `From ${source}` } });
    return 'created';
  }
  if (existing.expiryDate.getTime() === e.expiry.getTime()) return 'unchanged';
  const extended = e.expiry > existing.expiryDate;
  await t.renewable.update({ where: { id: existing.id }, data: { expiryDate: e.expiry, status: statusFor(e.expiry), ...(extended ? { cycle: { increment: 1 }, cycleStartedAt: new Date(), acknowledgedAt: null, snoozedUntil: null } : {}) } });
  await t.renewalEvent.create({ data: { renewableId: existing.id, action: extended ? 'RENEWED' : 'UPDATED', oldExpiry: existing.expiryDate, newExpiry: e.expiry, note: `From ${source}` } });
  return 'updated';
}

const nid = (a: Actor) => (a.id === 'system' ? null : a.id);
function statusFor(expiry: Date) {
  return daysBetween(dateOnly(todayIST()), expiry) < 0 ? ('EXPIRED' as const) : ('ACTIVE' as const);
}

// ───────────── CRUD (FR-REN-01, 02) ─────────────

async function scopedRenewable(actor: Actor, id: string, db: Db = prisma) {
  const r = await db.renewable.findFirst({ where: { id, asset: assetScope(actor) }, include: { asset: { select: { id: true, assetCode: true, make: true, model: true, locationId: true, status: true, category: { select: { name: true, isSoftware: true } }, location: { select: { namePath: true } } } } } });
  if (!r) throw notFound('Renewable');
  return r;
}

export async function createRenewable(actor: Actor, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
  const data = renewableInput.parse(input);
  return tx(async (t) => {
    const asset = await getScopedAsset(actor, data.assetId, t);
    if (asset.status === 'RETIRED') throw conflict(`Asset ${asset.assetCode} is retired.`);
    if (data.type === 'WARRANTY') {
      const dup = await t.renewable.findFirst({ where: { assetId: asset.id, type: 'WARRANTY', sourceKey: WARRANTY_KEY, status: { not: 'CANCELLED' } } });
      if (dup) throw conflict(`Asset ${asset.assetCode} already has a warranty renewable driven by its warranty end date; edit the asset's warranty end instead.`);
    }
    const r = await t.renewable.create({
      data: {
        assetId: asset.id, type: data.type, label: data.label, vendor: data.vendor, identifier: data.identifier, seats: data.seats ?? null,
        startDate: data.startDate ? dateOnly(data.startDate) : null, expiryDate: dateOnly(data.expiryDate), renewalTermMonths: data.renewalTermMonths ?? null,
        cost: data.cost ?? null, ownerUserId: data.ownerUserId || null, ownerEmployeeId: data.ownerEmployeeId || null, critical: data.critical,
        source: 'manual', sourceKey: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, status: statusFor(dateOnly(data.expiryDate)),
      },
    });
    await t.renewalEvent.create({ data: { renewableId: r.id, action: 'CREATED', newExpiry: r.expiryDate, cost: r.cost, actorId: actor.id } });
    await audit(t, actor, { action: 'RENEWABLE_CREATED', entityType: 'Renewable', entityId: r.id, entityLabel: r.label, after: data, details: { asset: asset.assetCode }, locationIds: [asset.locationId] });
    return r;
  });
}

export async function updateRenewable(actor: Actor, id: string, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
  const data = patchOf(renewableInput).omit({ assetId: true }).parse(input);
  return tx(async (t) => {
    const r = await scopedRenewable(actor, id, t);
    const u = await t.renewable.update({
      where: { id },
      data: {
        ...data, startDate: data.startDate === undefined ? undefined : data.startDate ? dateOnly(data.startDate) : null,
        expiryDate: data.expiryDate ? dateOnly(data.expiryDate) : undefined, ownerUserId: data.ownerUserId === undefined ? undefined : data.ownerUserId || null,
        ownerEmployeeId: data.ownerEmployeeId === undefined ? undefined : data.ownerEmployeeId || null,
        status: data.expiryDate ? statusFor(dateOnly(data.expiryDate)) : undefined,
      },
    });
    if (data.expiryDate && r.type === 'WARRANTY' && r.sourceKey === WARRANTY_KEY && r.asset.status !== 'RETIRED') await t.asset.update({ where: { id: r.assetId }, data: { warrantyEnd: dateOnly(data.expiryDate) } });
    await audit(t, actor, { action: 'RENEWABLE_UPDATED', entityType: 'Renewable', entityId: id, entityLabel: u.label, before: r, after: data, locationIds: [r.asset.locationId] });
    return u;
  });
}

export async function cancelRenewable(actor: Actor, id: string, reason: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden();
  return tx(async (t) => {
    const r = await scopedRenewable(actor, id, t);
    await t.renewable.update({ where: { id }, data: { status: 'CANCELLED' } });
    await t.renewalEvent.create({ data: { renewableId: id, action: 'CANCELLED', note: reason, actorId: actor.id } });
    await audit(t, actor, { action: 'RENEWABLE_CANCELLED', entityType: 'Renewable', entityId: id, entityLabel: r.label, details: { reason }, locationIds: [r.asset.locationId] });
    return { ok: true };
  });
}

// ───────────── Actions (FR-REN-05) ─────────────

export async function acknowledge(actor: Actor, id: string, note?: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
  return tx(async (t) => {
    const r = await scopedRenewable(actor, id, t);
    await t.renewable.update({ where: { id }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id } });
    await t.renewalEvent.create({ data: { renewableId: id, action: 'ACKNOWLEDGED', note, actorId: actor.id } });
    await audit(t, actor, { action: 'RENEWAL_ACKNOWLEDGED', entityType: 'Renewable', entityId: id, entityLabel: r.label, details: { cycle: r.cycle, note }, locationIds: [r.asset.locationId] });
    return { ok: true };
  });
}

export async function snooze(actor: Actor, id: string, until: string, note?: string) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= todayIST()) throw badRequest('Snooze date must be a future date (YYYY-MM-DD).');
  return tx(async (t) => {
    const r = await scopedRenewable(actor, id, t);
    await t.renewable.update({ where: { id }, data: { snoozedUntil: dateOnly(until) } });
    await t.renewalEvent.create({ data: { renewableId: id, action: 'SNOOZED', note: `Until ${until}${note ? `: ${note}` : ''}`, actorId: actor.id } });
    await audit(t, actor, { action: 'RENEWAL_SNOOZED', entityType: 'Renewable', entityId: id, entityLabel: r.label, details: { until, note }, locationIds: [r.asset.locationId] });
    return { ok: true };
  });
}

export const renewInput = z.object({ newExpiry: date, cost: z.number().nonnegative().nullable().optional(), proofDocumentId: z.string().nullable().optional(), note: z.string().trim().max(1000).optional() });

export async function markRenewed(actor: Actor, id: string, input: unknown) {
  if (actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
  const data = renewInput.parse(input);
  return tx(async (t) => {
    const r = await scopedRenewable(actor, id, t);
    const newExpiry = dateOnly(data.newExpiry);
    if (newExpiry <= r.expiryDate) throw badRequest(`The new expiry must be after the current expiry (${fmtDateOnly(r.expiryDate)}).`);
    if (data.proofDocumentId) {
      const doc = await t.document.findFirst({ where: { id: data.proofDocumentId, entityType: 'RENEWABLE', entityId: id, deletedAt: null } });
      if (!doc) throw badRequest('The proof document was not found on this renewable.');
    }
    const u = await t.renewable.update({
      where: { id },
      data: { startDate: r.expiryDate, expiryDate: newExpiry, cost: data.cost ?? r.cost, status: 'ACTIVE', cycle: { increment: 1 }, cycleStartedAt: new Date(), acknowledgedAt: null, acknowledgedById: null, snoozedUntil: null },
    });
    await t.renewalEvent.create({ data: { renewableId: id, action: 'RENEWED', oldExpiry: r.expiryDate, newExpiry, cost: data.cost ?? null, note: [data.note, data.proofDocumentId ? `proof ${data.proofDocumentId}` : null].filter(Boolean).join(' · ') || null, actorId: actor.id } });
    if (r.type === 'WARRANTY' && r.sourceKey === WARRANTY_KEY && r.asset.status !== 'RETIRED') await t.asset.update({ where: { id: r.assetId }, data: { warrantyEnd: newExpiry, updatedById: actor.id } });
    await audit(t, actor, { action: 'RENEWAL_RENEWED', entityType: 'Renewable', entityId: id, entityLabel: r.label, before: { expiry: fmtDateOnly(r.expiryDate), cycle: r.cycle }, after: { expiry: data.newExpiry, cycle: u.cycle, cost: data.cost }, details: { proofDocumentId: data.proofDocumentId, note: data.note }, locationIds: [r.asset.locationId] });
    return u;
  });
}

// ───────────── Queries (FR-REN-07) ─────────────

export interface RenewableFilters { type?: string[]; locationId?: string; withinDays?: number; status?: string[]; search?: string; assetId?: string; expired?: boolean }

export async function renewableWhere(actor: Actor, f: RenewableFilters): Promise<Prisma.RenewableWhereInput> {
  const and: Prisma.RenewableWhereInput[] = [{ asset: assetScope(actor) }];
  if (f.type?.length) and.push({ type: { in: f.type as RenewableType[] } });
  if (f.status?.length) and.push({ status: { in: f.status as Renewable['status'][] } });
  else and.push({ status: { not: 'CANCELLED' } });
  if (f.locationId) {
    const loc = await prisma.location.findUnique({ where: { id: f.locationId }, select: { idPath: true } });
    and.push({ asset: { location: { idPath: { startsWith: loc?.idPath ?? '/__none__/' } } } });
  }
  if (f.withinDays !== undefined) {
    const today = dateOnly(todayIST());
    and.push({ expiryDate: { gte: today, lte: new Date(today.getTime() + f.withinDays * 86_400_000) } });
  }
  if (f.expired) and.push({ expiryDate: { lt: dateOnly(todayIST()) } });
  if (f.assetId) and.push({ assetId: f.assetId });
  if (f.search) and.push({ OR: [{ label: { contains: f.search, mode: 'insensitive' } }, { vendor: { contains: f.search, mode: 'insensitive' } }, { identifier: { contains: f.search, mode: 'insensitive' } }, { asset: { assetCode: { contains: f.search, mode: 'insensitive' } } }] });
  return { AND: and };
}

export async function listRenewables(actor: Actor, f: RenewableFilters, p: { skip: number; take: number; sort?: string; dir?: 'asc' | 'desc' }) {
  const where = await renewableWhere(actor, f);
  const [rows, total] = await Promise.all([
    prisma.renewable.findMany({ where, orderBy: [{ expiryDate: p.sort === 'expiryDate' || !p.sort ? p.dir ?? 'asc' : 'asc' }, { id: 'asc' }], skip: p.skip, take: p.take, include: { asset: { select: { id: true, assetCode: true, make: true, model: true, location: { select: { namePath: true } } } } } }),
    prisma.renewable.count({ where }),
  ]);
  const today = dateOnly(todayIST());
  const owners = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.ownerUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const emps = await prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.ownerEmployeeId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const on = new Map([...owners, ...emps].map((o) => [o.id, o.name]));
  return {
    rows: rows.map((r) => ({
      ...r, cost: r.cost?.toString() ?? null, daysRemaining: daysBetween(today, r.expiryDate),
      owner: on.get(r.ownerUserId ?? '') ?? on.get(r.ownerEmployeeId ?? '') ?? null,
      reminderState: r.acknowledgedAt ? 'Acknowledged' : r.snoozedUntil && r.snoozedUntil >= today ? `Snoozed to ${fmtDateOnly(r.snoozedUntil)}` : 'Active',
    })),
    total,
  };
}

export async function getRenewable(actor: Actor, id: string) {
  const r = await scopedRenewable(actor, id);
  const [events, reminders] = await Promise.all([
    prisma.renewalEvent.findMany({ where: { renewableId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.renewalReminder.findMany({ where: { renewableId: id }, orderBy: { sentAt: 'desc' } }),
  ]);
  return { ...r, cost: r.cost?.toString() ?? null, daysRemaining: daysBetween(dateOnly(todayIST()), r.expiryDate), events, reminders };
}

// ───────────── Reminder policies (FR-REN-04) ─────────────

export const reminderPolicyInput = z.object({
  name: z.string().trim().min(1).max(120),
  types: z.array(z.enum(['WARRANTY', 'LICENCE', 'SUBSCRIPTION', 'AMC', 'CALIBRATION', 'INSURANCE', 'CERTIFICATE', 'OTHER'])).default([]),
  leadDays: z.array(z.number().int().min(0).max(730)).min(1).default([90, 30, 7, 1]),
  notifyOwner: z.boolean().default(true),
  notifyOwnerManager: z.boolean().default(false),
  roles: z.array(z.enum(['ADMIN', 'IT_OPERATOR', 'BRANCH_USER'])).default([]),
  userIds: z.array(z.string()).default([]),
  channelInApp: z.boolean().default(true),
  channelEmail: z.boolean().default(true),
  escalationDays: z.number().int().min(1).max(365).nullable().optional(),
  escalationRole: z.enum(['ADMIN', 'IT_OPERATOR', 'BRANCH_USER']).nullable().optional(),
  escalationUserIds: z.array(z.string()).default([]),
  escalateToOwnerManager: z.boolean().default(true),
  priority: z.number().int().min(1).max(10000).default(100),
  active: z.boolean().default(true),
});

export async function listReminderPolicies() {
  return prisma.reminderPolicy.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] });
}

export async function saveReminderPolicy(actor: Actor, id: string | null, input: unknown) {
  const data = reminderPolicyInput.parse(input);
  data.leadDays = [...new Set(data.leadDays)].sort((a, b) => b - a);
  return tx(async (t) => {
    const before = id ? await t.reminderPolicy.findUnique({ where: { id } }) : null;
    if (id && !before) throw notFound('Reminder policy');
    const p = id ? await t.reminderPolicy.update({ where: { id }, data: { ...data, escalationDays: data.escalationDays ?? null, escalationRole: data.escalationRole ?? null } }) : await t.reminderPolicy.create({ data: { ...data, escalationDays: data.escalationDays ?? null, escalationRole: data.escalationRole ?? null } });
    await audit(t, actor, { action: id ? 'REMINDER_POLICY_UPDATED' : 'REMINDER_POLICY_CREATED', entityType: 'ReminderPolicy', entityId: p.id, entityLabel: p.name, before, after: data });
    return p;
  });
}

const DEFAULT_POLICY: Omit<ReminderPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'Built-in default', types: [], leadDays: [90, 30, 7, 1], notifyOwner: true, notifyOwnerManager: false, roles: ['IT_OPERATOR'], userIds: [],
  channelInApp: true, channelEmail: true, escalationDays: 7, escalationRole: 'ADMIN', escalationUserIds: [], escalateToOwnerManager: true, priority: 9999, active: true,
};

// ───────────── Scheduler (FR-REN-04..06, B4) ─────────────

interface Recipients { userIds: string[]; emails: string[] }

async function recipientsFor(db: Db, r: Renewable & { asset: { locationId: string | null } }, roles: Role[], userIds: string[], owner: boolean, ownerManager: boolean): Promise<Recipients> {
  const out: Recipients = { userIds: [...userIds], emails: [] };
  const ownerEmp = r.ownerEmployeeId ? await db.employee.findUnique({ where: { id: r.ownerEmployeeId }, include: { user: true, manager: { include: { user: true } } } }) : null;
  const ownerUser = r.ownerUserId ? await db.user.findUnique({ where: { id: r.ownerUserId }, include: { employee: { include: { manager: { include: { user: true } } } } } }) : null;
  if (owner) {
    if (ownerUser) out.userIds.push(ownerUser.id);
    else if (ownerEmp?.user) out.userIds.push(ownerEmp.user.id);
    else if (ownerEmp?.email) out.emails.push(ownerEmp.email);
  }
  if (ownerManager) {
    const mgr = ownerUser?.employee?.manager ?? ownerEmp?.manager;
    if (mgr?.user) out.userIds.push(mgr.user.id);
    else if (mgr?.email) out.emails.push(mgr.email);
  }
  for (const role of roles) {
    if (role === 'BRANCH_USER') {
      // Only branch users whose scope contains the asset (recipients respect scope).
      if (r.asset.locationId) {
        const loc = await db.location.findUnique({ where: { id: r.asset.locationId }, select: { idPath: true } });
        const ids = loc?.idPath.split('/').filter(Boolean) ?? [];
        out.userIds.push(...(await db.user.findMany({ where: { role: 'BRANCH_USER', active: true, locationId: { in: ids } }, select: { id: true } })).map((u) => u.id));
      }
    } else out.userIds.push(...(await db.user.findMany({ where: { role, active: true }, select: { id: true } })).map((u) => u.id));
  }
  out.userIds = [...new Set(out.userIds)];
  out.emails = [...new Set(out.emails.map((e) => e.toLowerCase()))];
  return out;
}

async function deliver(db: Db, r: Renewable & { asset: { assetCode: string; locationId: string | null } }, tier: string, rec: Recipients, p: { inApp: boolean; email: boolean }, title: string, body: string) {
  // The unique (renewable, cycle, tier) row is the "fires once" guarantee — insert it first.
  const inserted = await db.renewalReminder.createMany({ data: [{ renewableId: r.id, cycle: r.cycle, tier, recipients: rec as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
  if (inserted.count === 0) return false;
  const eventKey = `renewal:${r.id}:c${r.cycle}:${tier}`;
  if (p.inApp) await notifyUsers(db, rec.userIds, { type: 'RENEWAL', title, body, link: `/renewals/${r.id}`, eventKey, email: p.email });
  else if (p.email) {
    const users = await db.user.findMany({ where: { id: { in: rec.userIds } }, select: { email: true } });
    for (const u of users) await enqueueEmail(u.email, title, body, eventKey, db);
  }
  if (p.email) for (const e of rec.emails) await enqueueEmail(e, title, body, eventKey, db);
  await audit(db, SYSTEM_ACTOR, { action: tier === 'ESCALATION' ? 'RENEWAL_ESCALATED' : 'RENEWAL_REMINDER_SENT', entityType: 'Renewable', entityId: r.id, entityLabel: r.label, details: { tier, cycle: r.cycle, recipients: rec.userIds.length + rec.emails.length, asset: r.asset.assetCode }, locationIds: [r.asset.locationId] });
  return true;
}

/** Evaluate every active renewable. Safe to run repeatedly: each tier is delivered once per cycle. */
export async function runRenewalReminders(asOf: string = todayIST()) {
  const today = dateOnly(asOf);
  const policies = (await prisma.reminderPolicy.findMany({ where: { active: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }));
  const renewables = await prisma.renewable.findMany({ where: { status: { in: ['ACTIVE', 'EXPIRED'] }, asset: { status: { not: 'RETIRED' } } }, include: { asset: { select: { assetCode: true, locationId: true, make: true, model: true } } } });
  let sent = 0, escalated = 0;
  for (const r of renewables) {
    const pol = policies.find((p) => !p.types.length || p.types.includes(r.type)) ?? (DEFAULT_POLICY as ReminderPolicy);
    const days = daysBetween(today, r.expiryDate);
    if (days < 0 && r.status !== 'EXPIRED') await prisma.renewable.update({ where: { id: r.id }, data: { status: 'EXPIRED' } });
    if (r.acknowledgedAt) continue; // acknowledged → cascade stops for this cycle
    const what = `${RENEWABLE_TYPE_LABEL[r.type]} "${r.label}" on ${r.asset.assetCode} (${r.asset.make} ${r.asset.model})`;
    if (r.snoozedUntil) {
      if (r.snoozedUntil > today) continue;
      const rec = await recipientsFor(prisma, r, pol.roles, pol.userIds, pol.notifyOwner, pol.notifyOwnerManager);
      if (await deliver(prisma, r, `SNOOZE:${fmtDateOnly(r.snoozedUntil)}`, rec, { inApp: pol.channelInApp, email: pol.channelEmail }, `Reminder (snooze ended): ${what}`, `${what} ${days >= 0 ? `expires in ${days} day(s) on ${fmtDateOnly(r.expiryDate)}` : `expired on ${fmtDateOnly(r.expiryDate)}`}. Acknowledge, snooze or mark renewed.`)) sent++;
      await prisma.renewable.update({ where: { id: r.id }, data: { snoozedUntil: null } });
      continue;
    }
    const lead = [...pol.leadDays].sort((a, b) => a - b);
    const tier = lead.find((t) => days <= t && days >= 0);
    if (tier !== undefined) {
      const rec = await recipientsFor(prisma, r, pol.roles, pol.userIds, pol.notifyOwner, pol.notifyOwnerManager);
      if (await deliver(prisma, r, String(tier), rec, { inApp: pol.channelInApp, email: pol.channelEmail }, `${days === 0 ? 'Expires today' : `Expires in ${days} day(s)`}: ${what}`, `${what} expires on ${fmtDateOnly(r.expiryDate)} (${tier}-day reminder). Acknowledge, snooze or mark renewed.`)) sent++;
    } else if (days < 0) {
      const rec = await recipientsFor(prisma, r, pol.roles, pol.userIds, pol.notifyOwner, pol.notifyOwnerManager);
      if (await deliver(prisma, r, 'EXPIRED', rec, { inApp: pol.channelInApp, email: pol.channelEmail }, `Expired: ${what}`, `${what} expired on ${fmtDateOnly(r.expiryDate)}.`)) sent++;
    }
    // FR-REN-06: escalate an unacknowledged critical item once per cycle.
    if (r.critical && pol.escalationDays) {
      const first = await prisma.renewalReminder.findFirst({ where: { renewableId: r.id, cycle: r.cycle, tier: { not: 'ESCALATION' } }, orderBy: { sentAt: 'asc' } });
      if (first && daysBetween(first.sentAt, today) >= pol.escalationDays) {
        const rec = await recipientsFor(prisma, r, pol.escalationRole ? [pol.escalationRole] : [], pol.escalationUserIds, false, pol.escalateToOwnerManager);
        if (await deliver(prisma, r, 'ESCALATION', rec, { inApp: true, email: true }, `Escalation: unacknowledged critical renewal — ${what}`, `${what} expires on ${fmtDateOnly(r.expiryDate)} and has not been acknowledged ${pol.escalationDays} day(s) after the first reminder.`)) escalated++;
      }
    }
  }
  return { evaluated: renewables.length, sent, escalated };
}
