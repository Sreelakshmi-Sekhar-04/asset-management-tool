import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import type { Actor } from '@/server/actor';
import { listAssets } from '@/server/services/assets';
import { listEmployees } from '@/server/services/employees';
import { listLocations } from '@/server/services/locations';
import { createDepartment, listDepartments } from '@/server/services/master';
import { bulkAssign } from '@/server/services/lifecycle';
import { createLocation } from '@/server/services/locations';
import { createEmployee } from '@/server/services/employees';
import { resolveOrg, listOrganizations, orgIdOfPath } from '@/server/org';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

/**
 * Organization context (§11-19): one organization is the head quarter, every screen shows that
 * organization's data, and a cross-organization assignment or transfer is refused on the server.
 */
let w: World;
let other: { org: { id: string; idPath: string; name: string }; branch: { id: string }; employee: { id: string }; asset: { id: string; assetCode: string } };
let otherActor: Actor;

beforeAll(async () => {
  w = await world();
  // A second organization, built the same way, so the two can be told apart. Its records are
  // created by an actor working in it, exactly as the application does.
  const unbound: Actor = { ...w.sys, orgId: null, orgIdPath: null, orgName: null };
  const org = await createLocation(unbound, { name: `Other Org ${w.s}`, type: 'ORGANIZATION', parentId: null });
  const branch = await createLocation(unbound, { name: `Other Branch ${w.s}`, type: 'BRANCH', parentId: org.id });
  const otherSys: Actor = { ...unbound, orgId: org.id, orgIdPath: org.idPath, orgName: org.name };
  otherActor = { ...w.it.actor, orgId: org.id, orgIdPath: org.idPath, orgName: org.name };
  const employee = await createEmployee(otherSys, { employeeCode: `EO${w.s}`, name: `Emp Other ${w.s}`, locationId: branch.id });
  const r = await (async () => {
    const { createAsset } = await import('@/server/services/assets');
    const res = await createAsset(otherActor, { categoryId: w.cat.id, make: 'Dell', model: 'Latitude 5440', serialNumber: `SN-OTHER-${w.s}`, locationId: branch.id, purchaseCost: 50000 });
    if (!('asset' in res) || !res.asset) throw new Error('asset not created');
    return res.asset;
  })();
  other = { org, branch, employee, asset: r };
});

describe('organization context', () => {
  it('the organization of a record is the root of its location path', async () => {
    const branch = await prisma.location.findUniqueOrThrow({ where: { id: w.A.id } });
    expect(orgIdOfPath(branch.idPath)).toBe(w.org.id);
    expect((await listOrganizations()).map((o) => o.id)).toContain(other.org.id);
  });

  it('a branch user always works in their own organization and cannot be switched out of it', async () => {
    const own = await resolveOrg(prisma, { role: 'BRANCH_USER', scopeIdPath: w.A.idPath }, other.org.id);
    expect(own?.id).toBe(w.org.id);
  });

  it('assets, employees, locations and departments are all filtered by the selected organization', async () => {
    const mine = await w.asset(w.A.id);
    const ours = await listAssets(w.it.actor, {}, { skip: 0, take: 200 });
    expect(ours.rows.map((r) => r.id)).toContain(mine.id);
    expect(ours.rows.map((r) => r.id)).not.toContain(other.asset.id);

    const theirs = await listAssets(otherActor, {}, { skip: 0, take: 200 });
    expect(theirs.rows.map((r) => r.id)).toContain(other.asset.id);
    expect(theirs.rows.map((r) => r.id)).not.toContain(mine.id);

    const emps = await listEmployees(w.it.actor, { skip: 0, take: 200 });
    expect(emps.rows.map((e) => e.id)).not.toContain(other.employee.id);

    // Even the wide list used by destination pickers stays inside the organization.
    const locs = await listLocations(w.it.actor, { all: true, includeInactive: true });
    expect(locs.map((l) => l.id)).not.toContain(other.branch.id);

    const dept = await createDepartment(otherActor, { name: `Other Dept ${w.s}` });
    expect((await listDepartments(w.it.actor)).map((d) => d.id)).not.toContain(dept.id);
    expect((await listDepartments(otherActor)).map((d) => d.id)).toContain(dept.id);
  });

  it('an asset cannot be assigned to an employee of another organization', async () => {
    const mine = await w.asset(w.A.id);
    await rejectsWith(bulkAssign(w.it.actor, { assetIds: [mine.id], holder: { type: 'EMPLOYEE', id: other.employee.id } }), 400, /different organization/);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: mine.id } })).holderType).toBeNull();
  });

  it('an asset cannot be transferred to a location of another organization', async () => {
    const mine = await w.asset(w.A.id);
    await rejectsWith(bulkAssign(w.it.actor, { assetIds: [mine.id], holder: { type: 'LOCATION', id: other.branch.id } }), 400, /different organization/);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: mine.id } })).locationId).toBe(w.A.id);
  });

  it('the refusal does not depend on which organization is selected', async () => {
    // Selecting the other organization does not let its location receive this organization's asset.
    const mine = await w.asset(w.A.id);
    await rejectsWith(bulkAssign({ ...w.it.actor, orgId: other.org.id, orgIdPath: other.org.idPath }, { assetIds: [mine.id], holder: { type: 'LOCATION', id: other.branch.id } }), 400);
  });
});
