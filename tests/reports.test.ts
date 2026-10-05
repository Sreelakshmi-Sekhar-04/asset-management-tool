import { beforeAll, describe, expect, it } from 'vitest';
import { GET as reportRoute } from '@/app/api/reports/[key]/route';
import { runReport } from '@/server/services/reports';
import { dashboard } from '@/server/services/dashboard';
import { listAssets } from '@/server/services/assets';
import { assignAsset } from '@/server/services/lifecycle';
import { world, type World } from './fixtures';
import { call, sessionCookie } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
  for (let i = 0; i < 3; i++) await w.asset(w.A.id);
  const a = await w.asset(w.A.id);
  await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
  await w.asset(w.C.id);
});

describe('reports and dashboard', () => {
  it('the CSV export has exactly the rows and cells shown on screen', async () => {
    const cookie = await sessionCookie(w.brA.user.email);
    const screen = await runReport(w.brA.actor, 'asset-register', {}, { skip: 0, take: 1000 });
    const res = await call(reportRoute, { url: '/api/reports/asset-register?format=csv', cookie, params: { key: 'asset-register' } });
    expect(res.status).toBe(200);
    const text = (await res.res.text()).replace(/^﻿/, '');
    const body = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    const dataLines = body.slice(body.findIndex((l) => l.startsWith('Asset ID')) + 1);
    expect(dataLines.length).toBe(screen.total);
    for (const row of screen.rows) expect(text).toContain(String(row._cells[0]));
  });

  it('dashboard figures reconcile with the asset list for the same user', async () => {
    for (const actor of [w.brA.actor, w.it.actor]) {
      const d = await dashboard(actor);
      const all = await listAssets(actor, { statuses: ['IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR'] }, { skip: 0, take: 1 });
      const assigned = await listAssets(actor, { statuses: ['ASSIGNED'] }, { skip: 0, take: 1 });
      expect(d.assets.total).toBe(all.total);
      expect(d.assets.assigned).toBe(assigned.total);
    }
  });
});
