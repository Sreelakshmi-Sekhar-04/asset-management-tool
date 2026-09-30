import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma, tx, type Db } from '@/lib/db';
import { badRequest, conflict, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit, diff } from '../audit';
import { assertLocationInScope, employeeScope } from '../scope';

export const employeeInput = z.object({
  employeeCode: z.string().trim().min(1, 'Employee ID is required').max(40),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('').transform(() => null)),
  departmentId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  managerId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

const include = {
  department: { select: { id: true, name: true } },
  location: { select: { id: true, namePath: true } },
  manager: { select: { id: true, name: true, employeeCode: true, locationId: true } },
  _count: { select: { heldAssets: true } },
} satisfies Prisma.EmployeeInclude;

export async function listEmployees(actor: Actor, p: { search?: string; departmentId?: string; locationId?: string; active?: string; skip: number; take: number; sort?: string; dir?: 'asc' | 'desc' }) {
  const where: Prisma.EmployeeWhereInput = { AND: [employeeScope(actor)] };
  const and = where.AND as Prisma.EmployeeWhereInput[];
  if (p.search) and.push({ OR: [{ name: { contains: p.search, mode: 'insensitive' } }, { employeeCode: { contains: p.search, mode: 'insensitive' } }, { email: { contains: p.search, mode: 'insensitive' } }] });
  if (p.departmentId) and.push({ departmentId: p.departmentId });
  if (p.locationId) {
    const loc = await prisma.location.findUnique({ where: { id: p.locationId } });
    if (loc) and.push({ location: { idPath: { startsWith: loc.idPath } } });
  }
  if (p.active) and.push({ active: p.active === 'true' });
  const sortable = ['name', 'employeeCode', 'email', 'createdAt'];
  const orderBy = [{ [sortable.includes(p.sort ?? '') ? p.sort! : 'name']: p.dir ?? 'asc' }, { id: 'asc' as const }];
  const [rows, total] = await Promise.all([
    prisma.employee.findMany({ where, include, orderBy, skip: p.skip, take: p.take }),
    prisma.employee.count({ where }),
  ]);
  // TC-ACC-20: never disclose a manager outside the branch user's scope.
  if (actor.role === 'BRANCH_USER') {
    const scopeIds = new Set((await prisma.location.findMany({ where: { idPath: { startsWith: actor.scopeIdPath! } }, select: { id: true } })).map((l) => l.id));
    for (const r of rows) if (r.manager && !scopeIds.has(r.manager.locationId ?? '')) (r as { manager: unknown }).manager = null;
  }
  return { rows, total };
}

export async function getEmployee(actor: Actor, id: string) {
  const e = await prisma.employee.findFirst({ where: { AND: [{ id }, employeeScope(actor)] }, include: { ...include, heldAssets: { select: { id: true, assetCode: true, make: true, model: true, status: true, serialNumber: true } } } });
  if (!e) throw notFound('Employee');
  return e;
}

async function assertNoManagerCycle(db: Db, employeeId: string | null, managerId: string | null | undefined) {
  if (!managerId) return;
  if (employeeId && managerId === employeeId) throw badRequest('An employee cannot be their own manager.');
  let cur: string | null = managerId;
  const seen = new Set<string>();
  while (cur) {
    if (employeeId && cur === employeeId) throw badRequest('This manager link would create a circular reporting chain.');
    if (seen.has(cur)) break;
    seen.add(cur);
    const m: { managerId: string | null } | null = await db.employee.findUnique({ where: { id: cur }, select: { managerId: true } });
    cur = m?.managerId ?? null;
  }
}

export async function createEmployee(actor: Actor, input: unknown) {
  const data = employeeInput.parse(input);
  if (data.locationId) await assertLocationInScope(actor, data.locationId);
  return tx(async (t) => {
    if (await t.employee.findUnique({ where: { employeeCode: data.employeeCode } })) throw conflict(`Employee ID ${data.employeeCode} already exists.`);
    await assertNoManagerCycle(t, null, data.managerId);
    const e = await t.employee.create({
      data: { employeeCode: data.employeeCode, name: data.name, email: data.email ?? null, departmentId: data.departmentId || null, locationId: data.locationId || null, managerId: data.managerId || null, fieldSources: {} },
      include,
    });
    await audit(t, actor, { action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: e.id, entityLabel: `${e.employeeCode} ${e.name}`, after: data, locationIds: [e.locationId] });
    return e;
  });
}

export async function updateEmployee(actor: Actor, id: string, input: unknown, opts: { confirmDeactivate?: boolean } = {}) {
  const data = employeeInput.partial().parse(input);
  return tx(async (t) => {
    const e = await t.employee.findFirst({ where: { AND: [{ id }, employeeScope(actor)] } });
    if (!e) throw notFound('Employee');
    if (data.locationId) await assertLocationInScope(actor, data.locationId, t);
    if (data.employeeCode && data.employeeCode !== e.employeeCode && (await t.employee.findUnique({ where: { employeeCode: data.employeeCode } })))
      throw conflict(`Employee ID ${data.employeeCode} already exists.`);
    if (data.managerId !== undefined) await assertNoManagerCycle(t, id, data.managerId);
    if (data.active === false && e.active) {
      const held = await t.asset.findMany({ where: { holderEmployeeId: id }, select: { assetCode: true } });
      if (held.length && !opts.confirmDeactivate)
        throw conflict(`${e.name} holds ${held.length} asset(s): ${held.slice(0, 10).map((h) => h.assetCode).join(', ')}${held.length > 10 ? '…' : ''}. Confirm to deactivate anyway, or check them in / reassign first.`, { code: 'EMPLOYEE_HOLDS_ASSETS', assets: held.map((h) => h.assetCode) });
    }
    const fieldSources = { ...(e.fieldSources as Record<string, string>) };
    for (const k of Object.keys(data)) fieldSources[k] = 'MANUAL';
    const u = await t.employee.update({
      where: { id },
      data: { ...data, email: data.email === undefined ? undefined : data.email ?? null, departmentId: data.departmentId === undefined ? undefined : data.departmentId || null, locationId: data.locationId === undefined ? undefined : data.locationId || null, managerId: data.managerId === undefined ? undefined : data.managerId || null, fieldSources },
      include,
    });
    const d = diff(e as unknown as Record<string, unknown>, data as Record<string, unknown>);
    await audit(t, actor, { action: data.active === false ? 'EMPLOYEE_DEACTIVATED' : 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: id, entityLabel: `${u.employeeCode} ${u.name}`, before: d.before, after: d.after, locationIds: [e.locationId, u.locationId] });
    return u;
  });
}

/** FR-EMP-03 offboarding: bulk check-in or reassign every asset held, optionally then deactivate. */
export async function offboardEmployee(actor: Actor, id: string, input: { action: 'CHECK_IN' | 'REASSIGN'; toEmployeeId?: string; condition?: string; remarks?: string; deactivate?: boolean }) {
  const e = await prisma.employee.findFirst({ where: { AND: [{ id }, employeeScope(actor)] } });
  if (!e) throw notFound('Employee');
  const { bulkCheckIn, bulkReassign } = await import('./lifecycle');
  const assets = await prisma.asset.findMany({ where: { holderEmployeeId: id }, select: { id: true } });
  let result: unknown = { processed: 0 };
  if (assets.length) {
    if (input.action === 'CHECK_IN') result = await bulkCheckIn(actor, assets.map((a) => a.id), { condition: input.condition, remarks: input.remarks ?? `Offboarding of ${e.name}` });
    else {
      if (!input.toEmployeeId) throw badRequest('Choose the employee to reassign to.');
      result = await bulkReassign(actor, assets.map((a) => a.id), input.toEmployeeId, input.remarks ?? `Offboarding of ${e.name}`);
    }
  }
  if (input.deactivate) await updateEmployee(actor, id, { active: false }, { confirmDeactivate: true });
  return result;
}
