import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/format';
import { addUnlisted, createCampaign, markAllPresent, markLines, reviewLine, reviewUnlisted, signOff, submitTask } from '@/server/services/verification';
import { acknowledge, createRenewable, markRenewed, runRenewalReminders } from '@/server/services/renewables';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

describe('verification', () => {
  it('snapshots the branch, collects marks, blocks early sign-off, and applies accepted findings', async () => {
    const present = await w.asset(w.A.id), missing = await w.asset(w.A.id), wrong = await w.asset(w.A.id, { hostname: `OLD-${w.s}` });
    const c = await createCampaign(w.it.actor, { name: `Q ${w.s}`, dueDate: addDays(todayIST(), 14), scope: 'BRANCHES', scopeLocationIds: [w.A.id] });
    const task = await prisma.verificationTask.findFirstOrThrow({ where: { campaignId: c.campaign.id, locationId: w.A.id } });
    // An asset registered after the snapshot is not on the checklist.
    await w.asset(w.A.id);
    const lines = await prisma.verificationLine.findMany({ where: { taskId: task.id } });
    expect(lines.length).toBe(3);
    const byAsset = new Map(lines.map((l) => [l.assetId, l]));

    await rejectsWith(markAllPresent(w.brC.actor, task.id), 404);
    await markLines(w.brA.actor, task.id, { lines: [
      { lineId: byAsset.get(missing.id)!.id, result: 'MISSING' },
      { lineId: byAsset.get(wrong.id)!.id, result: 'WRONG_DETAILS', correctedHostname: `NEW-${w.s}` },
    ] });
    await rejectsWith(submitTask(w.brA.actor, task.id), 400, /not yet marked/);
    await markAllPresent(w.brA.actor, task.id);
    expect((await prisma.verificationLine.findUniqueOrThrow({ where: { id: byAsset.get(missing.id)!.id } })).result).toBe('MISSING');
    const u = await addUnlisted(w.brA.actor, task.id, { categoryId: w.cat.id, make: 'Lenovo', model: 'T14', serialNumber: `UNL-${w.s}` });
    await submitTask(w.brA.actor, task.id);

    await rejectsWith(signOff(w.it.actor, task.id), 409, /still need review/);
    await rejectsWith(reviewLine(w.brA.actor, task.id, byAsset.get(missing.id)!.id, { decision: 'ACCEPTED' }), 403);
    await reviewLine(w.it.actor, task.id, byAsset.get(missing.id)!.id, { decision: 'ACCEPTED' });
    await reviewLine(w.it.actor, task.id, byAsset.get(wrong.id)!.id, { decision: 'ACCEPTED' });
    const r = await reviewUnlisted(w.it.actor, task.id, u.unlisted.id, { decision: 'ACCEPTED' });
    await signOff(w.it.actor, task.id, 'Done');

    expect((await prisma.asset.findUniqueOrThrow({ where: { id: missing.id } })).flagMissing).toBe(true);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: wrong.id } })).hostname).toBe(`NEW-${w.s}`);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: present.id } })).flagMissing).toBe(false);
    const created = await prisma.asset.findFirstOrThrow({ where: { assetCode: r.assetCode! } });
    expect(created.locationId).toBe(w.A.id);
  });
});

describe('renewals', () => {
  it('each reminder tier fires once per cycle; renewing starts a new cycle', async () => {
    const a = await w.asset(w.A.id);
    const today = todayIST();
    const r = await createRenewable(w.it.actor, { assetId: a.id, type: 'LICENCE', label: `Office ${w.s}`, expiryDate: addDays(today, 25) });
    await runRenewalReminders(today);
    await runRenewalReminders(today);
    let sent = await prisma.renewalReminder.findMany({ where: { renewableId: r.id } });
    expect(sent.map((s) => s.tier)).toEqual(['30']);
    // A later run inside the 7-day window fires only the 7-day tier.
    await runRenewalReminders(addDays(today, 20));
    sent = await prisma.renewalReminder.findMany({ where: { renewableId: r.id }, orderBy: { sentAt: 'asc' } });
    expect(sent.map((s) => s.tier)).toEqual(['30', '7']);
    expect(await prisma.notification.count({ where: { userId: w.it.user.id, eventKey: { startsWith: `renewal:${r.id}:` } } })).toBe(2);

    await rejectsWith(markRenewed(w.it.actor, r.id, { newExpiry: addDays(today, 1) }), 400, /after the current expiry/);
    const u = await markRenewed(w.it.actor, r.id, { newExpiry: addDays(today, 390), cost: 1200 });
    expect(u.cycle).toBe(r.cycle + 1);
    await runRenewalReminders(today);
    expect(await prisma.renewalReminder.count({ where: { renewableId: r.id, cycle: u.cycle } })).toBe(0);
  });

  it('acknowledging stops further reminders for the cycle; branch users cannot act', async () => {
    const a = await w.asset(w.A.id);
    const r = await createRenewable(w.it.actor, { assetId: a.id, type: 'AMC', label: `AMC ${w.s}`, expiryDate: addDays(todayIST(), 5) });
    await rejectsWith(acknowledge(w.brA.actor, r.id), 403);
    await acknowledge(w.it.actor, r.id, 'PO raised');
    await runRenewalReminders(todayIST());
    expect(await prisma.renewalReminder.count({ where: { renewableId: r.id } })).toBe(0);
  });
});
