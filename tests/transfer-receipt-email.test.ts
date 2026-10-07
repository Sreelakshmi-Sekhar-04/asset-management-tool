import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { decide } from '@/server/services/approvals';
import { listAssets } from '@/server/services/assets';
import { assetTimeline } from '@/server/services/history';
import { assignAsset, bulkAssign } from '@/server/services/lifecycle';
import { emailsForRequest } from '@/server/services/notifications';
import { closeNotReceived, listToReceive, receiveTransfer } from '@/server/services/transfer-receipt';
import { sendPendingEmails } from '@/worker/email';
import { world, type World } from './fixtures';
import { rejectsWith } from './helpers';
import { smtpSink } from './smtp-sink';

let w: World;
beforeAll(async () => { w = await world(); });
afterAll(() => { process.env.SMTP_URL = ''; });

type Result = { pendingApproval?: { id: string; requestNo: string } };
type Actor = World['admin']['actor'];
const asset = (id: string) => prisma.asset.findUniqueOrThrow({ where: { id } });
const shipment = (requestId: string) => prisma.transfer.findFirstOrThrow({ where: { approvalRequestId: requestId }, include: { lines: true } });
const row = async (id: string) => (await listAssets(w.it.actor, { ids: [id] }, { skip: 0, take: 1 })).rows[0];

/** Raise a transfer of the assets from A to B and give both approvals; returns the request id. */
async function approvedTransfer(ids: string[], to = w.B.id) {
  const r = await bulkAssign(w.it.actor, { assetIds: ids, holder: { type: 'LOCATION', id: to }, remarks: 'Receipt test' }) as Result;
  const id = r.pendingApproval!.id;
  await decide(w.admin.actor, id, 'APPROVE');
  await decide(to === w.B.id ? w.brB.actor : w.brC.actor, id, 'APPROVE');
  return id;
}
const receipt = async (actor: Actor, requestId: string, lines: { assetId: string; condition: string; remarks?: string }[], receivedAt = new Date()) => {
  const s = await shipment(requestId);
  return receiveTransfer(actor, s.id, {
    receivedAt: receivedAt.toISOString(), receivedByName: 'Store keeper',
    lines: lines.map((l) => ({ lineId: s.lines.find((x) => x.assetId === l.assetId)!.id, condition: l.condition, remarks: l.remarks })),
  });
};

describe('receipt after approval', () => {
  it('approved is not received: the Status says so and the asset stays at the source', async () => {
    const a = await w.asset(w.A.id);
    const id = await approvedTransfer([a.id]);
    expect(await row(a.id)).toMatchObject({ displayStatus: 'TRANSFER_APPROVED', locationId: w.A.id });
    expect((await listToReceive(w.brB.actor)).map((s) => s.approvalRequestId)).toContain(id);
    expect((await listToReceive(w.brC.actor)).map((s) => s.approvalRequestId)).not.toContain(id);
  });

  it('received damaged: remarks are required, the asset moves and its condition is recorded in the history', async () => {
    const a = await w.asset(w.A.id);
    const id = await approvedTransfer([a.id]);
    await rejectsWith(receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'DAMAGED' }]), 400, /remarks/i);
    const r = await receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'DAMAGED', remarks: 'Screen has minor crack during transportation' }]);
    expect(r).toMatchObject({ status: 'COMPLETED', received: 1, notReceived: 0 });
    expect(await asset(a.id)).toMatchObject({ locationId: w.B.id, condition: 'Damaged', transferStatus: 'RECEIVED' });
    expect(await row(a.id)).toMatchObject({ displayStatus: 'TRANSFERRED', condition: 'Damaged' });
    const s = await shipment(id);
    expect(s.lines[0]).toMatchObject({ status: 'RECEIVED', receivedCondition: 'DAMAGED', remark: 'Screen has minor crack during transportation', receivedByName: 'Store keeper' });
    const tl = await assetTimeline(w.admin.actor, a.id);
    const titles = tl.map((i) => i.title);
    expect(titles.some((t) => t.startsWith('Transfer requested to'))).toBe(true);
    expect(titles.some((t) => /first approval \(admin manager\) given/.test(t))).toBe(true);
    expect(titles.some((t) => /destination location manager approval given/.test(t))).toBe(true);
    expect(titles.some((t) => /dispatched: both approvals given, awaiting receipt/.test(t))).toBe(true);
    const got = tl.find((i) => i.kind === 'TRANSFER_RECEIVED')!;
    expect(got.details).toEqual(expect.arrayContaining(['Condition: Damaged', 'Received by: Store keeper', 'Remarks: Screen has minor crack during transportation']));
    expect(titles.some((t) => /completed$/.test(t))).toBe(true);
  });

  it('not received: no silent completion; it stays at the source as an exception until it arrives late', async () => {
    const [a, b] = [await w.asset(w.A.id), await w.asset(w.A.id)];
    const id = await approvedTransfer([a.id, b.id]);
    // Every asset on the transfer needs a condition.
    await rejectsWith(receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'GOOD' }]), 400, /every asset/);
    const r = await receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'PARTIALLY_DAMAGED', remarks: 'Charger missing' }, { assetId: b.id, condition: 'NOT_RECEIVED', remarks: 'Not in the delivery' }]);
    expect(r).toMatchObject({ status: 'PARTIALLY_RECEIVED', received: 1, notReceived: 1 });
    expect(await asset(a.id)).toMatchObject({ locationId: w.B.id, condition: 'Partially damaged' });
    expect(await asset(b.id)).toMatchObject({ locationId: w.A.id, transferStatus: 'NOT_RECEIVED', flagTransferException: true });
    expect(await row(b.id)).toMatchObject({ displayStatus: 'TRANSFER_NOT_RECEIVED' });
    expect(await prisma.transferException.count({ where: { assetId: b.id, status: 'OPEN' } })).toBe(1);
    // Locked while the exception is open.
    await rejectsWith(assignAsset(w.it.actor, b.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } }), 409, /not received/);
    // It turns up: the destination receives it late and the transfer completes.
    const late = await receipt(w.brB.actor, id, [{ assetId: b.id, condition: 'GOOD' }]);
    expect(late).toMatchObject({ status: 'COMPLETED', received: 1 });
    expect(await asset(b.id)).toMatchObject({ locationId: w.B.id, transferStatus: 'RECEIVED', flagTransferException: false });
    expect(await prisma.transferException.findFirstOrThrow({ where: { assetId: b.id } })).toMatchObject({ status: 'RESOLVED', resolution: 'RESENT' });
    // History is kept, including the exception.
    const kinds = (await assetTimeline(w.admin.actor, b.id)).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['TRANSFER_NOT_RECEIVED', 'TRANSFER_EXCEPTION_RAISED', 'TRANSFER_RECEIVED']));
  });

  it('an Administrator can close a not-received exception when the asset never left', async () => {
    const a = await w.asset(w.A.id);
    const id = await approvedTransfer([a.id]);
    await receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'NOT_RECEIVED', remarks: 'Not dispatched' }]);
    const line = (await shipment(id)).lines[0];
    await rejectsWith(closeNotReceived(w.brB.actor, line.id, { note: 'x' }), 403);
    expect(await closeNotReceived(w.admin.actor, line.id, { note: 'Found in the Branch A store room' })).toMatchObject({ status: 'CANCELLED' });
    expect(await asset(a.id)).toMatchObject({ locationId: w.A.id, transferStatus: 'NONE', flagTransferException: false });
    expect(await row(a.id)).toMatchObject({ displayStatus: 'IN_STOCK' });
    await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
  });

  it('only the destination manager or an Administrator confirms receipt, and not before the approval', async () => {
    const a = await w.asset(w.A.id);
    const id = await approvedTransfer([a.id]);
    await rejectsWith(receipt(w.brA.actor, id, [{ assetId: a.id, condition: 'GOOD' }]), 403);
    await rejectsWith(receipt(w.it.actor, id, [{ assetId: a.id, condition: 'GOOD' }]), 403);
    await rejectsWith(receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'GOOD' }], new Date(Date.now() - 86_400_000)), 400, /before the transfer was approved/);
    await receipt(w.admin.actor, id, [{ assetId: a.id, condition: 'GOOD' }]);
    await rejectsWith(receipt(w.brB.actor, id, [{ assetId: a.id, condition: 'GOOD' }]), 409);
  });
});

describe('one Status in the register', () => {
  it('filters by the combined Status', async () => {
    const pend = await w.asset(w.A.id);
    const plain = await w.asset(w.A.id);
    await bulkAssign(w.it.actor, { assetIds: [pend.id], holder: { type: 'LOCATION', id: w.B.id } });
    const ids = [pend.id, plain.id];
    const q = async (statuses: string[]) => (await listAssets(w.it.actor, { ids, statuses }, { skip: 0, take: 5 })).rows.map((r) => r.id);
    expect(await q(['PENDING_TRANSFER_APPROVAL'])).toEqual([pend.id]);
    expect(await q(['IN_STOCK'])).toEqual([plain.id]);
    expect((await q(['IN_STOCK', 'PENDING_TRANSFER_APPROVAL'])).sort()).toEqual([...ids].sort());
    expect(await row(pend.id)).toMatchObject({ status: 'IN_STOCK', displayStatus: 'PENDING_TRANSFER_APPROVAL' });
  });
});

describe('approval emails', () => {
  it('queues detailed emails for each approver and the receiver; without SMTP nothing is marked sent', async () => {
    const a = await w.asset(w.A.id);
    const r = await bulkAssign(w.it.actor, { assetIds: [a.id], holder: { type: 'LOCATION', id: w.B.id }, remarks: 'For the new counter' }) as Result;
    const id = r.pendingApproval!.id;
    const first = await prisma.emailOutbox.findFirstOrThrow({ where: { to: w.admin.user.email, eventKey: { startsWith: `approval:${id}:` } } });
    expect(first.subject).toContain(r.pendingApproval!.requestNo);
    for (const s of [a.assetCode, 'Dell Latitude 5440', a.serialNumber!, w.A.namePath, w.B.namePath, w.it.user.name, 'For the new counter', `/approvals/${id}`, 'step 1 of 2']) expect(first.text).toContain(s);
    expect(first.html).toContain('Approve or reject the transfer');

    // No SMTP: the worker refuses to pretend; the message is failed with the reason.
    process.env.SMTP_URL = '';
    await sendPendingEmails();
    expect(await prisma.emailOutbox.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'FAILED', lastError: expect.stringContaining('SMTP_URL is not configured') });

    await decide(w.admin.actor, id, 'APPROVE', 'Fine by me');
    const second = await prisma.emailOutbox.findFirstOrThrow({ where: { to: w.brB.user.email, eventKey: `approval:${id}:order:2` } });
    expect(second.text).toContain('awaiting your approval as the destination location manager');
    expect(second.text).toContain(`Admin manager approval: Approved by ${w.admin.user.name}`);
    expect(second.text).toContain('"Fine by me"');

    await decide(w.brB.actor, id, 'APPROVE');
    const third = await prisma.emailOutbox.findFirstOrThrow({ where: { to: w.brB.user.email, eventKey: `transfer:${id}:dispatched` } });
    expect(third.subject).toMatch(/^Confirm receipt/);
    // The request shows each email with its real state.
    const shown = await emailsForRequest(w.it.actor, id);
    expect(shown.map((m) => m.to)).toEqual(expect.arrayContaining([w.admin.user.email, w.brB.user.email]));
  });

  it('with SMTP, SENT only when the server accepts; a refused recipient is FAILED with the server error', async () => {
    const sink = await smtpSink({ refuse: [w.brC.user.email] });
    try {
      process.env.SMTP_URL = sink.url;
      await prisma.emailOutbox.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } });
      const ok = await prisma.emailOutbox.create({ data: { to: w.brB.user.email, subject: 'Hello', text: 'Body', html: '<b>Body</b>', eventKey: `test:${w.s}:ok` } });
      const bad = await prisma.emailOutbox.create({ data: { to: w.brC.user.email, subject: 'Hello', text: 'Body', eventKey: `test:${w.s}:bad` } });
      const res = await sendPendingEmails();
      expect(res).toEqual({ sent: 1, failed: 1 });
      expect(await prisma.emailOutbox.findUniqueOrThrow({ where: { id: ok.id } })).toMatchObject({ status: 'SENT', lastError: null });
      expect(sink.mails.map((m) => m.to)).toEqual([[w.brB.user.email]]);
      const b = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: bad.id } });
      expect(b.status).toBe('PENDING'); // retried with back-off, never marked sent
      expect(b.lastError).toMatch(/550|No such user|rejected|refused/i);
    } finally {
      await sink.close();
      process.env.SMTP_URL = '';
    }
  });
});
