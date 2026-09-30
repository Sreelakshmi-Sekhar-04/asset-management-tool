import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { Db } from '@/lib/db';
import type { Actor } from '../actor';
import { auditMany } from '../audit';
import { sendInvite } from '../auth/session';
import type { ParsedRow } from './parse';
import { LocationResolver, type ImportContext, type RowResult, type ValidationResult } from './common';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmployeePlan { employeeCode: string; name: string; email: string | null; department: string | null; departmentId: string | null; locationPath: string | null; locationId: string | null; managerCode: string | null; active: boolean; changes?: Record<string, unknown> }

export async function validateEmployees(db: Db, ctx: ImportContext, rows: ParsedRow[]): Promise<ValidationResult<EmployeePlan>> {
  const existing = await db.employee.findMany({ include: { manager: { select: { employeeCode: true } }, _count: { select: { heldAssets: true } } } });
  const byCode = new Map(existing.map((e) => [e.employeeCode.toLowerCase(), e]));
  const depts = await db.department.findMany();
  const deptByName = new Map(depts.map((d) => [d.name.toLowerCase(), d]));
  const locs = new LocationResolver(db, ctx.createMissing);
  await locs.load();
  const deptToCreate = new Map<string, string>();
  const seen = new Map<string, number>();
  const fileCodes = new Set(rows.map((r) => (r.data.employeeid ?? '').trim().toLowerCase()).filter(Boolean));
  const out: RowResult<EmployeePlan>[] = [];
  for (const r of rows) {
    const g = (k: string) => (r.data[k] ?? '').trim();
    const msgs: string[] = [];
    const code = g('employeeid');
    if (!code) msgs.push('Employee ID is required.');
    if (!g('name')) msgs.push('Name is required.');
    if (g('email') && !EMAIL_RE.test(g('email'))) msgs.push(`Email "${g('email')}" is not valid.`);
    if (code) { const k = code.toLowerCase(); if (seen.has(k)) msgs.push(`Employee ID "${code}" is duplicated within the file (rows ${seen.get(k)} and ${r.rowNumber}).`); else seen.set(k, r.rowNumber); }
    let departmentId: string | null = null;
    if (g('department')) {
      const d = deptByName.get(g('department').toLowerCase());
      if (d) departmentId = d.id;
      else if (ctx.createMissing) deptToCreate.set(g('department').toLowerCase(), g('department'));
      else msgs.push(`Unknown department "${g('department')}". Tick "create missing" to create it.`);
    }
    let locationId: string | null = null;
    if (g('location')) {
      const l = locs.resolve(g('location'));
      if (l.kind === 'found') locationId = l.id;
      else if (l.kind === 'unknown') msgs.push(`Unknown location "${g('location')}". Tick "create missing" to create it.`);
      else if (l.kind === 'ambiguous') msgs.push(`Location "${g('location')}" is ambiguous; give the full path.`);
    }
    const mgr = g('manageremployeeid') || null;
    if (mgr && !byCode.has(mgr.toLowerCase()) && !fileCodes.has(mgr.toLowerCase())) msgs.push(`Unknown manager employee ID "${mgr}".`);
    if (mgr && code && mgr.toLowerCase() === code.toLowerCase()) msgs.push('An employee cannot be their own manager.');
    const activeRaw = g('active').toLowerCase();
    if (activeRaw && !['y', 'n', 'yes', 'no', 'true', 'false', '1', '0', 'active', 'inactive'].includes(activeRaw)) msgs.push(`Active must be Y or N (got "${g('active')}").`);
    const active = !activeRaw || ['y', 'yes', 'true', '1', 'active'].includes(activeRaw);
    const plan: EmployeePlan = { employeeCode: code, name: g('name'), email: g('email').toLowerCase() || null, department: g('department') || null, departmentId, locationPath: g('location') || null, locationId, managerCode: mgr, active };
    if (msgs.length) { out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'REJECTED', messages: msgs, plan }); continue; }
    const ex = byCode.get(code.toLowerCase());
    if (ex) {
      const changes: Record<string, unknown> = {};
      if (plan.name !== ex.name) changes.name = plan.name;
      if (plan.email && plan.email !== (ex.email ?? '')) changes.email = plan.email;
      if (plan.department && (departmentId ?? `new:${plan.department}`) !== ex.departmentId) changes.department = plan.department;
      if (plan.locationPath && (locationId ?? `new:${plan.locationPath}`) !== ex.locationId) changes.location = plan.locationPath;
      if (mgr && mgr.toLowerCase() !== (ex.manager?.employeeCode ?? '').toLowerCase()) changes.manager = mgr;
      if (active !== ex.active) changes.active = active;
      if (!Object.keys(changes).length) { out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'UNCHANGED', messages: [`Matches existing employee ${ex.employeeCode}; no changes.`], matchedId: ex.id, plan }); continue; }
      if (ctx.mode === 'CREATE_ONLY') { out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'REJECTED', messages: [`Duplicate employee ID ${code}. Use "Create or update" to update it.`], matchedId: ex.id, plan }); continue; }
      if (changes.active === false && ex._count.heldAssets > 0) { out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'REJECTED', messages: [`${ex.name} holds ${ex._count.heldAssets} asset(s); use the offboarding view to check them in or reassign before deactivating.`], matchedId: ex.id, plan }); continue; }
      plan.changes = changes;
      out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'UPDATED', messages: [`Updates ${Object.keys(changes).join(', ')}.`], matchedId: ex.id, plan });
      continue;
    }
    out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'CREATED', messages: [], plan });
  }
  // Circular manager chains are rejected (TC-EMP-03).
  const mgrOf = new Map<string, string | null>();
  for (const e of existing) mgrOf.set(e.employeeCode.toLowerCase(), e.manager?.employeeCode.toLowerCase() ?? null);
  for (const r of out) if (r.outcome !== 'REJECTED' && r.plan!.managerCode) mgrOf.set(r.plan!.employeeCode.toLowerCase(), r.plan!.managerCode.toLowerCase());
  for (const r of out) {
    if (r.outcome === 'REJECTED' || !r.plan!.managerCode) continue;
    const start = r.plan!.employeeCode.toLowerCase();
    let cur = mgrOf.get(start) ?? null; const seenC = new Set<string>();
    while (cur && !seenC.has(cur)) { if (cur === start) { r.outcome = 'REJECTED'; r.messages = [`Manager link for ${r.plan!.employeeCode} would create a circular reporting chain.`]; break; } seenC.add(cur); cur = mgrOf.get(cur) ?? null; }
  }
  return { rows: out, locationsToCreate: locs.toCreate(), departmentsToCreate: [...deptToCreate.values()] };
}

export async function applyEmployees(t: Db, actor: Actor, jobId: string, v: ValidationResult<EmployeePlan>) {
  const locMap = await new LocationResolver(t, true).createAll(actor, v.locationsToCreate);
  const deptIds = new Map((await t.department.findMany()).map((d) => [d.name.toLowerCase(), d.id]));
  for (const name of v.departmentsToCreate) if (!deptIds.has(name.toLowerCase())) deptIds.set(name.toLowerCase(), (await t.department.create({ data: { name } })).id);
  const locId = async (p: EmployeePlan) => p.locationId ?? (p.locationPath ? locMap.get(LocationResolver.norm(p.locationPath).toLowerCase()) ?? null : null);
  const results: { rowNumber: number; resultId: string | null; resultCode: string | null }[] = [];
  const createRows = v.rows.filter((r) => r.outcome === 'CREATED');
  const ids = new Map<string, string>();
  const data: Prisma.EmployeeCreateManyInput[] = [];
  for (const r of createRows) {
    const p = r.plan!;
    const id = crypto.randomUUID();
    ids.set(p.employeeCode.toLowerCase(), id);
    data.push({ id, employeeCode: p.employeeCode, name: p.name, email: p.email, departmentId: p.department ? deptIds.get(p.department.toLowerCase()) ?? null : null, locationId: (await locId(p)) ?? null, active: p.active, source: 'IMPORT', fieldSources: {} });
    results.push({ rowNumber: r.rowNumber, resultId: id, resultCode: p.employeeCode });
  }
  for (let i = 0; i < data.length; i += 1000) await t.employee.createMany({ data: data.slice(i, i + 1000) });
  const allCodes = new Map((await t.employee.findMany({ select: { id: true, employeeCode: true } })).map((e) => [e.employeeCode.toLowerCase(), e.id]));
  for (const r of createRows) if (r.plan!.managerCode) await t.employee.update({ where: { id: ids.get(r.plan!.employeeCode.toLowerCase())! }, data: { managerId: allCodes.get(r.plan!.managerCode.toLowerCase()) } });
  await auditMany(t, actor, createRows.map((r) => ({ action: 'EMPLOYEE_CREATED', entityType: 'Employee', entityId: ids.get(r.plan!.employeeCode.toLowerCase()), entityLabel: `${r.plan!.employeeCode} ${r.plan!.name}`, after: r.plan, details: { importJobId: jobId, row: r.rowNumber } })));
  for (const r of v.rows.filter((x) => x.outcome === 'UPDATED')) {
    const p = r.plan!;
    const c = p.changes!;
    const before = await t.employee.findUniqueOrThrow({ where: { id: r.matchedId! } });
    const upd: Prisma.EmployeeUncheckedUpdateInput = {};
    if ('name' in c) upd.name = p.name;
    if ('email' in c) upd.email = p.email;
    if ('department' in c) upd.departmentId = deptIds.get(p.department!.toLowerCase()) ?? null;
    if ('location' in c) upd.locationId = (await locId(p)) ?? null;
    if ('manager' in c) upd.managerId = allCodes.get(p.managerCode!.toLowerCase()) ?? null;
    if ('active' in c) upd.active = p.active;
    const fs = { ...(before.fieldSources as Record<string, string>) };
    for (const k of Object.keys(c)) fs[k] = 'IMPORT';
    upd.fieldSources = fs;
    await t.employee.update({ where: { id: before.id }, data: upd });
    await auditMany(t, actor, [{ action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: before.id, entityLabel: `${before.employeeCode} ${before.name}`, before: { name: before.name, email: before.email, departmentId: before.departmentId, locationId: before.locationId, managerId: before.managerId, active: before.active }, after: c, details: { importJobId: jobId, row: r.rowNumber } }]);
    results.push({ rowNumber: r.rowNumber, resultId: before.id, resultCode: before.employeeCode });
  }
  return results;
}

// ───────────── Branch users (FR-CFG-05 bulk) ─────────────

export interface BranchUserPlan { email: string; name: string; locationId: string | null; branchPath: string }

export async function validateBranchUsers(db: Db, _ctx: ImportContext, rows: ParsedRow[]): Promise<ValidationResult<BranchUserPlan>> {
  const users = await db.user.findMany({ select: { id: true, email: true, role: true, locationId: true } });
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const locs = new LocationResolver(db, false);
  await locs.load();
  const seen = new Map<string, number>();
  const out: RowResult<BranchUserPlan>[] = [];
  for (const r of rows) {
    const g = (k: string) => (r.data[k] ?? '').trim();
    const msgs: string[] = [];
    const email = g('email').toLowerCase();
    if (!g('branch')) msgs.push('Branch is required.');
    if (!email) msgs.push('Email is required.');
    else if (!EMAIL_RE.test(email)) msgs.push(`Email "${g('email')}" is not valid.`);
    if (email) { if (seen.has(email)) msgs.push(`Email ${email} is duplicated within the file (rows ${seen.get(email)} and ${r.rowNumber}).`); else seen.set(email, r.rowNumber); }
    const l = g('branch') ? locs.resolve(g('branch')) : null;
    if (l && l.kind !== 'found') msgs.push(`Unknown or ambiguous branch "${g('branch')}".`);
    const plan: BranchUserPlan = { email, name: g('name') || (l?.kind === 'found' ? l.path.split(' / ').pop()! : email), locationId: l?.kind === 'found' ? l.id : null, branchPath: g('branch') };
    if (msgs.length) { out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'REJECTED', messages: msgs, plan }); continue; }
    const ex = byEmail.get(email);
    if (ex) {
      if (ex.role === 'BRANCH_USER' && ex.locationId === plan.locationId) out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'UNCHANGED', messages: ['User already exists with this branch binding.'], matchedId: ex.id, plan });
      else out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'REJECTED', messages: [`A user with email ${email} already exists with a different role or binding.`], matchedId: ex.id, plan });
      continue;
    }
    out.push({ rowNumber: r.rowNumber, data: r.data, outcome: 'CREATED', messages: ['An invite email will be sent.'], plan });
  }
  return { rows: out, locationsToCreate: [], departmentsToCreate: [] };
}

export async function applyBranchUsers(t: Db, actor: Actor, jobId: string, v: ValidationResult<BranchUserPlan>) {
  const results: { rowNumber: number; resultId: string | null; resultCode: string | null }[] = [];
  const invites: string[] = [];
  for (const r of v.rows.filter((x) => x.outcome === 'CREATED')) {
    const p = r.plan!;
    const u = await t.user.create({ data: { email: p.email, name: p.name, role: 'BRANCH_USER', locationId: p.locationId } });
    invites.push(u.id);
    await auditMany(t, actor, [{ action: 'USER_CREATED', entityType: 'User', entityId: u.id, entityLabel: u.email, after: { email: u.email, role: 'BRANCH_USER', branch: p.branchPath }, details: { importJobId: jobId, row: r.rowNumber }, locationIds: [p.locationId] }]);
    results.push({ rowNumber: r.rowNumber, resultId: u.id, resultCode: u.email });
  }
  return { results, afterCommit: async () => { for (const id of invites) await sendInvite(id, actor); } };
}
