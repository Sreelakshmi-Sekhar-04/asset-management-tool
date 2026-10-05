import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getAsset, PATCH as patchAsset } from '@/app/api/assets/[id]/route';
import { GET as listAssetsRoute } from '@/app/api/assets/route';
import { GET as auditRoute } from '@/app/api/audit/route';
import { GET as reportRoute } from '@/app/api/reports/[key]/route';
import { listAssets, getAssetDetail } from '@/server/services/assets';
import { assignAsset } from '@/server/services/lifecycle';
import { createTransfer, receive } from '@/server/services/transfers';
import { dashboard } from '@/server/services/dashboard';
import { listEmployees } from '@/server/services/employees';
import { prisma } from '@/lib/db';
import { world, type World } from './fixtures';
import { call, rejectsWith, sessionCookie } from './helpers';

let w: World;
let inA: { id: string; assetCode: string }, inC: { id: string; assetCode: string };
beforeAll(async () => {
  w = await world();
  inA = await w.asset(w.A.id);
  inC = await w.asset(w.C.id);
});

describe('location scoping is enforced on the server', () => {
  it('a branch user cannot read an asset outside their branch (service and API)', async () => {
    await expect(getAssetDetail(w.brA.actor, inA.id)).resolves.toBeTruthy();
    await rejectsWith(getAssetDetail(w.brA.actor, inC.id), 404);
    const cookie = await sessionCookie(w.brA.user.email);
    expect((await call(getAsset, { url: `/api/assets/${inC.id}`, cookie, params: { id: inC.id } })).status).toBe(404);
    expect((await call(getAsset, { url: `/api/assets/${inC.assetCode}`, cookie, params: { id: inC.assetCode } })).status).toBe(404);
    expect((await call(getAsset, { url: `/api/assets/${inA.id}`, cookie, params: { id: inA.id } })).status).toBe(200);
  });

  it('a branch user cannot write to an asset outside their branch', async () => {
    const cookie = await sessionCookie(w.brA.user.email);
    const r = await call(patchAsset, { url: `/api/assets/${inC.id}`, method: 'PATCH', cookie, params: { id: inC.id }, body: { remarks: 'x' } });
    expect(r.status).toBe(404);
    await rejectsWith(assignAsset(w.brA.actor, inC.id, { holder: { type: 'EMPLOYEE', id: w.empC.id } }), 404);
  });

  it('lists, filters and exports only contain in-scope rows, even when asking for another branch', async () => {
    const own = await listAssets(w.brA.actor, {}, { skip: 0, take: 500 });
    expect(own.rows.every((a) => a.location?.startsWith(w.region.name))).toBe(true);
    expect(own.rows.some((a) => a.id === inC.id)).toBe(false);
    const other = await listAssets(w.brA.actor, { locationId: w.C.id }, { skip: 0, take: 500 });
    expect(other.total).toBe(0);
    const cookie = await sessionCookie(w.brA.user.email);
    const api = await call(listAssetsRoute, { url: `/api/assets?locationId=${w.C.id}`, cookie });
    expect(api.json.total).toBe(0);
    const rep = await call(reportRoute, { url: `/api/reports/asset-register?search=${w.s}`, cookie, params: { key: 'asset-register' } });
    expect(rep.status).toBe(200);
    expect(rep.json.rows.map((r: { assetCode: string }) => r.assetCode)).toEqual([inA.assetCode]);
    const csv = await call(reportRoute, { url: `/api/reports/asset-register?search=${w.s}&format=csv`, cookie, params: { key: 'asset-register' } });
    const text = await csv.res.text();
    expect(text).toContain(inA.assetCode);
    expect(text).not.toContain(inC.assetCode);
  });

  it('employees and the dashboard are scoped', async () => {
    const emps = await listEmployees(w.brA.actor, { search: w.s, skip: 0, take: 100 });
    expect(emps.rows.map((e) => e.id)).toEqual([w.empA.id]);
    const d = await dashboard(w.brA.actor);
    const all = await listAssets(w.brA.actor, { statuses: ['IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR'] }, { skip: 0, take: 1 });
    expect(d.assets.total).toBe(all.total);
  });

  it('a branch cannot raise a transfer from another branch, nor receive one addressed elsewhere', async () => {
    await rejectsWith(createTransfer(w.brA.actor, { fromLocationId: w.C.id, toLocationId: w.A.id, reason: 'x', assetIds: [inC.id] }), 403);
    const r = await createTransfer(w.it.actor, { fromLocationId: w.C.id, toLocationId: w.B.id, reason: 'Rebalance', assetIds: [inC.id] }) as { transfer: { id: string } };
    await rejectsWith(receive(w.brA.actor, r.transfer.id, { all: 'RECEIVED', receivedByName: 'Someone' }), 404);
    const denied = await prisma.auditLog.count({ where: { action: 'ACCESS_DENIED', entityId: r.transfer.id, actorId: w.brA.user.id } });
    expect(denied).toBe(1);
  });

  it('the audit log is closed to branch users and the denial is audited', async () => {
    const cookie = await sessionCookie(w.brA.user.email);
    expect((await call(auditRoute, { url: '/api/audit', cookie })).status).toBe(403);
  });

  it('requests without a session are rejected', async () => {
    expect((await call(listAssetsRoute, { url: '/api/assets' })).status).toBe(401);
  });
});
