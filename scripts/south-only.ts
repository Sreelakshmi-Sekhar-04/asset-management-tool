/**
 * DEVELOPMENT / UAT ONLY — keeps only South India in an existing database, without wiping it.
 *
 *   npm run db:south-only            shows what would change, changes nothing
 *   npm run db:south-only -- --yes   applies it
 *
 * For a database loaded from an older seed (North / South / West regions, Arun Mathew and
 * Lakshmi Varma as the approvers). It
 *   1. builds Joy Alukkas → South India → Kerala, Tamil Nadu, Karnataka, Andhra Pradesh,
 *      Telangana → the demo branches, reusing locations that already exist (by name), so
 *      assets, people and history keep their location;
 *   2. moves every other location that lies in one of those five states under its state;
 *   3. removes every location outside South India (North, East, West, …). What pointed at one
 *      first moves to Kochi MG Road: assets (recorded as a correction in each asset's history),
 *      employees and user accounts; a pending transfer into one is withdrawn. A location still
 *      named by transfer or physical audit history is deactivated instead (hidden from every
 *      list and dropdown) so that history stays intact;
 *   4. makes the two approvers Farah (sreelakshmisekhar04@gmail.com, Administrator, first
 *      approval) and Asha Monon (sreelakshmi.sekhar@digitalfuturus.com, Trivandrum manager,
 *      second approval and receipt), updating the existing accounts rather than adding new ones.
 *
 * Safe to run again: a database that is already South-only is left as it is. For a clean demo
 * from scratch use `npm run db:reset-demo -- --yes` (deletes all data) instead.
 */
import type { Location } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR, type Actor } from '@/server/actor';
import { audit } from '@/server/audit';
import { createLocation, updateLocation } from '@/server/services/locations';
import { recordMovement } from '@/server/services/movement';
import { ASHA, FARAH, SOUTH_BRANCHES, SOUTH_STATES } from './demo-data';

const APPLY = process.argv.includes('--yes');
const sys: Actor = { ...SYSTEM_ACTOR, name: 'South-only cleanup' };
/** Older names of the demo branches. */
const ALIASES: Record<string, string[]> = { Trivandrum: ['Thiruvananthapuram'], 'Chennai T. Nagar': ['Chennai'], 'Bengaluru Jayanagar': ['Bengaluru', 'Bangalore'], 'Hyderabad Banjara Hills': ['Hyderabad'] };
/** Paths (as they were) of the locations kept as part of South India; everything beneath them stays too. */
const kept: string[] = [];
const log = (s: string) => console.log(`${APPLY ? '' : '[dry run] '}${s}`);
const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function fresh(id: string) { return prisma.location.findUniqueOrThrow({ where: { id } }); }

async function ensureChild(parent: Location, name: string, type: 'REGION' | 'STATE' | 'BRANCH', extra: { state?: string | null; code?: string } = {}, aliases: string[] = [], under?: string) {
  const all = await prisma.location.findMany({ where: { idPath: { startsWith: under ?? parent.idPath }, id: { not: parent.id } } });
  const found = all.find((l) => l.parentId === parent.id && eq(l.name, name))
    ?? all.find((l) => l.type === type && [name, ...aliases].some((n) => eq(l.name, n)));
  if (found) {
    kept.push(found.idPath);
    const needs = found.parentId !== parent.id || found.name !== name || found.type !== type || (extra.state !== undefined && found.state !== extra.state) || !found.active;
    if (needs) {
      log(`Move/rename ${found.namePath} → ${parent.namePath} / ${name}`);
      if (APPLY) return updateLocation(sys, found.id, { parentId: parent.id, name, type, active: true, ...(extra.state !== undefined ? { state: extra.state } : {}) });
    }
    return found;
  }
  log(`Create ${parent.namePath} / ${name}`);
  if (!APPLY) return { ...parent, id: `new:${name}`, name, namePath: `${parent.namePath} / ${name}`, idPath: `${parent.idPath}new:${name}/` } as Location;
  const code = extra.code && !(await prisma.location.findUnique({ where: { code: extra.code } })) ? extra.code : null;
  return createLocation(sys, { name, type, parentId: parent.id, state: extra.state ?? null, code });
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Refusing to change a production database.');
  const roots = await prisma.location.findMany({ where: { parentId: null } });
  const org = roots.find((r) => eq(r.name, 'Joy Alukkas')) ?? roots.find((r) => r.type === 'ORGANIZATION');
  if (!org) throw new Error('No organization found. Load the demo with `npm run db:reset-demo -- --yes` instead.');

  // 1. South India, its five states and the demo branches.
  const southOld = await prisma.location.findFirst({ where: { parentId: org.id, OR: [{ name: { equals: 'South India', mode: 'insensitive' } }, { name: { equals: 'South', mode: 'insensitive' } }] } });
  let south: Location;
  if (southOld) {
    kept.push(southOld.idPath);
    if (southOld.name !== 'South India' || southOld.type !== 'REGION') { log(`Rename ${southOld.namePath} → South India`); if (APPLY) await updateLocation(sys, southOld.id, { name: 'South India', type: 'REGION' }); }
    south = APPLY ? await fresh(southOld.id) : southOld;
  } else south = await ensureChild(org, 'South India', 'REGION', { code: 'SI' }, [], org.idPath);
  const states: Record<string, Location> = {};
  for (const [name, code] of SOUTH_STATES) states[name] = await ensureChild(south, name, 'STATE', { state: name, code }, [], org.idPath);
  for (const [state, name, code] of SOUTH_BRANCHES) {
    const parent = APPLY && !states[state].id.startsWith('new:') ? await fresh(states[state].id) : states[state];
    await ensureChild(parent, name, 'BRANCH', { state, code }, ALIASES[name] ?? [], org.idPath);
  }
  if (APPLY) south = await fresh(south.id);

  // 2. Anything else that lies in a South state moves under that state; the rest is outside South India.
  const all = await prisma.location.findMany({ where: { idPath: { startsWith: org.idPath }, id: { not: org.id } }, orderBy: { depth: 'asc' } });
  const byId = new Map(all.map((l) => [l.id, l]));
  const stateOf = (l: Location): string | null => {
    for (let cur: Location | undefined = l; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      const hit = SOUTH_STATES.find(([s]) => eq(cur!.state ?? '', s) || (cur!.type === 'STATE' && eq(cur!.name, s)));
      if (hit) return hit[0];
    }
    return null;
  };
  const outside: Location[] = [];
  for (const l of all) {
    if (l.idPath.startsWith(south.idPath) || kept.some((k) => l.idPath.startsWith(k))) continue;
    if ([...outside].some((o) => l.idPath.startsWith(o.idPath))) continue; // beneath a location already going
    const st = stateOf(l);
    if (st && l.type !== 'REGION' && states[st]) {
      log(`Keep ${l.namePath} (in ${st}): move under South India / ${st}`);
      if (APPLY) await updateLocation(sys, l.id, { parentId: states[st].id });
      kept.push(l.idPath);
    } else outside.push(l);
  }

  // 3. Remove the locations outside South India, deepest first, after moving what pointed at them.
  const fallback = await prisma.location.findFirst({ where: { name: 'Kochi MG Road', idPath: { startsWith: org.idPath } } });
  if (outside.length && !fallback && APPLY) throw new Error('Kochi MG Road not found; cannot move records off the removed locations.');
  const doomed = (await prisma.location.findMany({ where: { OR: outside.map((o) => ({ idPath: { startsWith: o.idPath } })) } }))
    .sort((a, b) => b.depth - a.depth);
  for (const l of outside) log(`Remove ${l.namePath} and everything beneath it (outside South India)`);
  let removed = 0, deactivated = 0, movedAssets = 0;
  if (APPLY && doomed.length) {
    const ids = doomed.map((d) => d.id);
    // A pending transfer into a removed location is withdrawn (its assets never moved).
    const pending = await prisma.approvalRequest.findMany({ where: { status: 'PENDING', action: 'TRANSFER' } });
    for (const r of pending) {
      if (!ids.includes((r.payload as { toLocationId?: string }).toLocationId ?? '')) continue;
      await prisma.approvalTask.updateMany({ where: { requestId: r.id, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'SKIPPED' } });
      await prisma.approvalRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', decidedAt: new Date(), failureReason: 'Destination removed: demo data limited to South India' } });
      await prisma.asset.updateMany({ where: { transferRequestId: r.id }, data: { transferStatus: 'NONE', transferRequestId: null } });
      await audit(prisma, sys, { action: 'APPROVAL_CANCELLED', entityType: 'ApprovalRequest', entityId: r.id, entityLabel: r.requestNo, details: { reason: 'Destination outside South India was removed' }, locationIds: r.locationIds });
      log(`Withdrew ${r.requestNo} (into a removed location)`);
    }
    const assets = await prisma.asset.findMany({ where: { OR: [{ locationId: { in: ids } }, { holderLocationId: { in: ids } }] } });
    for (const a of assets) {
      const holderMoves = a.holderLocationId && ids.includes(a.holderLocationId);
      const updated = await prisma.asset.update({ where: { id: a.id }, data: { locationId: fallback!.id, ...(holderMoves ? { holderLocationId: fallback!.id } : {}) } });
      await recordMovement(prisma, sys, 'CORRECTION', a, { id: a.id, status: updated.status, locationId: fallback!.id, holder: updated.holderType ? { type: updated.holderType, id: (updated.holderEmployeeId ?? updated.holderDepartmentId ?? updated.holderLocationId)! } : null }, {
        isCorrection: true, reason: 'Demo data limited to South India: its location was removed',
      });
      movedAssets++;
    }
    await prisma.user.updateMany({ where: { locationId: { in: ids } }, data: { locationId: fallback!.id } });
    await prisma.employee.updateMany({ where: { locationId: { in: ids } }, data: { locationId: fallback!.id } });
    for (const d of doomed) {
      const history = await prisma.transfer.count({ where: { OR: [{ fromLocationId: d.id }, { toLocationId: d.id }] } }) + await prisma.verificationTask.count({ where: { locationId: d.id } });
      const children = await prisma.location.count({ where: { parentId: d.id } });
      if (history || children) {
        await prisma.location.update({ where: { id: d.id }, data: { active: false, managerId: null } });
        await audit(prisma, sys, { action: 'LOCATION_DEACTIVATED', entityType: 'Location', entityId: d.id, entityLabel: d.namePath, details: { reason: 'Outside South India; kept only for transfer / physical audit history' }, locationIds: [d.id] });
        deactivated++;
      } else {
        await prisma.location.delete({ where: { id: d.id } });
        await audit(prisma, sys, { action: 'LOCATION_DELETED', entityType: 'Location', entityId: d.id, entityLabel: d.namePath, details: { reason: 'Outside South India' } });
        removed++;
      }
    }
  }

  // 4. The approvers: Farah (first approval) and Asha Monon (Trivandrum: second approval and receipt).
  const tvm = await prisma.location.findFirst({ where: { name: 'Trivandrum', idPath: { startsWith: org.idPath } } });
  const firstApprover = (org.managerId ? await prisma.user.findFirst({ where: { id: org.managerId, role: 'ADMIN' } }) : null)
    ?? await prisma.user.findFirst({ where: { email: { in: [FARAH.email, 'arun.mathew@itam-demo.example.com'] } } });
  const secondApprover = (tvm?.managerId ? await prisma.user.findUnique({ where: { id: tvm.managerId } }) : null)
    ?? await prisma.user.findFirst({ where: { email: { in: [ASHA.email, 'lakshmi.varma@itam-demo.example.com'] } } });
  for (const [u, want] of [[firstApprover, FARAH], [secondApprover, ASHA]] as const) {
    if (!u) { log(`No account found for ${want.name}; reload the demo (npm run db:reset-demo -- --yes) to create it.`); continue; }
    if (u.email === want.email && u.name === want.name) continue;
    const clash = await prisma.user.findFirst({ where: { email: want.email, id: { not: u.id } } });
    if (clash) { log(`Cannot give ${u.name} the address ${want.email}: ${clash.name} already uses it.`); continue; }
    log(`Account ${u.name} <${u.email}> → ${want.name} <${want.email}>`);
    if (!APPLY) continue;
    await prisma.user.update({ where: { id: u.id }, data: { name: want.name, email: want.email } });
    if (u.employeeId) await prisma.employee.update({ where: { id: u.employeeId }, data: { name: want.name, email: want.email } });
    await audit(prisma, sys, { action: 'USER_UPDATED', entityType: 'User', entityId: u.id, entityLabel: want.email, before: { name: u.name, email: u.email }, after: { name: want.name, email: want.email } });
  }
  if (APPLY && secondApprover && tvm && tvm.managerId !== secondApprover.id) await updateLocation(sys, tvm.id, { managerId: secondApprover.id });

  console.log(APPLY
    ? `Done: ${removed} location(s) removed, ${deactivated} kept inactive for history, ${movedAssets} asset(s) moved to Kochi MG Road.`
    : '\nNothing was changed. Run again with --yes to apply:  npm run db:south-only -- --yes');
}

main()
  .catch((e) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
