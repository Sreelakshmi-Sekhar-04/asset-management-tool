import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { actorForUser, decide, savePolicy } from '@/server/services/approvals';
import { assignAsset, bulkCheckIn, checkInAsset } from '@/server/services/lifecycle';
import { createCategory } from '@/server/services/master';
import { createTransfer, listTransfers, receive, resolveExceptions, resolveIdentifiers } from '@/server/services/transfers';
import { createUser } from '@/server/services/users';
import { world, PASSWORD, type World } from './fixtures';
import { rejectsWith } from './helpers';

let w: World;
beforeAll(async () => { w = await world(); });

type T = { transfer: { id: string; status: string }; pendingApproval?: { id: string } };
const lines = (transferId: string) => prisma.transferLine.findMany({ where: { transferId }, orderBy: { assetCode: 'asc' } });

describe('transfers', () => {
  it('scanned label content (a scan link or a bare Asset ID) resolves to the asset; unknown codes are reported', async () => {
    const a = await w.asset(w.A.id), b = await w.asset(w.A.id);
    const r = await resolveIdentifiers(w.it.actor, `https://itam.example.com/scan/${encodeURIComponent(a.assetCode)}\n${b.assetCode.toLowerCase()}\nNOPE-404`, w.A.id);
    expect(r.found.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.unresolved).toEqual(['NOPE-404']);
  });

  it('assets ticked in the register resolve by record id and suggest the location that holds them all', async () => {
    const a = await w.asset(w.A.id), b = await w.asset(w.A.id);
    const r = await resolveIdentifiers(w.it.actor, '', undefined, [a.id, b.id, 'gone-id']);
    expect(r.found.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.unresolved).toEqual(['gone-id']);
    expect(r.commonLocationId).toBe(w.A.id);
    const c = await w.asset(w.B.id);
    const mixed = await resolveIdentifiers(w.it.actor, '', undefined, [a.id, c.id]);
    const [la, lb] = await Promise.all([w.A.id, w.B.id].map((id) => prisma.location.findUniqueOrThrow({ where: { id } })));
    const shared = la.idPath.split('/').filter(Boolean).filter((seg, i) => lb.idPath.split('/').filter(Boolean)[i] === seg);
    expect(mixed.commonLocationId).toBe(shared.at(-1) ?? null);
  });

  it('an IT-raised transfer is in transit at once, locks its assets, and moves them only on receipt', async () => {
    const a1 = await w.asset(w.A.id), a2 = await w.asset(w.A.id);
    const r = await createTransfer(w.it.actor, { fromLocationId: w.A.id, toLocationId: w.B.id, reason: 'Rebalance', assetIds: [a1.id, a2.id] }) as T;
    expect(r.transfer.status).toBe('IN_TRANSIT');
    // Locked: a second transfer and an assignment are refused.
    await rejectsWith(createTransfer(w.it.actor, { fromLocationId: w.A.id, toLocationId: w.C.id, reason: 'Again', assetIds: [a1.id] }), 400);
    await rejectsWith(assignAsset(w.it.actor, a1.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } }), 409);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a1.id } })).locationId).toBe(w.A.id);

    // Partial receipt: one received, one not received with a mandatory reason.
    const [l1, l2] = await lines(r.transfer.id);
    await rejectsWith(receive(w.it.actor, r.transfer.id, { receivedByName: 'Guard', lines: [{ lineId: l2.id, outcome: 'NOT_RECEIVED' }] }), 400, /reason/i);
    const res = await receive(w.it.actor, r.transfer.id, { receivedByName: 'Guard', lines: [{ lineId: l1.id, outcome: 'RECEIVED' }, { lineId: l2.id, outcome: 'NOT_RECEIVED', reason: 'Box empty' }] });
    expect(res.status).toBe('COMPLETED');
    const [x1, x2] = await prisma.asset.findMany({ where: { id: { in: [l1.assetId, l2.assetId] } }, orderBy: { assetCode: 'asc' } });
    expect(x1.locationId).toBe(w.B.id);
    expect(x2.locationId).toBe(w.A.id);
    expect(x2.flagTransferException).toBe(true);
    // A processed line cannot be received twice.
    await rejectsWith(receive(w.it.actor, r.transfer.id, { receivedByName: 'Guard', lines: [{ lineId: l1.id, outcome: 'RECEIVED' }] }), 409);

    // Resolving the exception as "located at sender" clears the flag.
    const ex = await prisma.transferException.findFirstOrThrow({ where: { lineId: l2.id } });
    await rejectsWith(resolveExceptions(w.brA.actor, { exceptionIds: [ex.id], resolution: 'LOCATED_AT_SENDER' }), 403);
    await resolveExceptions(w.it.actor, { exceptionIds: [ex.id], resolution: 'LOCATED_AT_SENDER', note: 'Found in store' });
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: l2.assetId } })).flagTransferException).toBe(false);
  });

  it('the Transfer and Reason column filters find a transfer by number, Asset ID or reason text', async () => {
    const a = await w.asset(w.A.id);
    const r = await createTransfer(w.it.actor, { fromLocationId: w.A.id, toLocationId: w.B.id, reason: `Colfilter move ${w.s}`, assetIds: [a.id] }) as T & { transfer: { transferNo: string } };
    const ids = async (f: Parameters<typeof listTransfers>[1]) => (await listTransfers(w.it.actor, f, { skip: 0, take: 50 })).rows.map((x) => x.id);
    expect(await ids({ reason: `colfilter MOVE ${w.s}` })).toEqual([r.transfer.id]);
    expect(await ids({ transferNo: a.assetCode.toLowerCase() })).toEqual([r.transfer.id]);
    expect(await ids({ transferNo: r.transfer.transferNo, reason: `Colfilter move ${w.s}` })).toEqual([r.transfer.id]);
    expect(await ids({ transferNo: r.transfer.transferNo, reason: 'not this one' })).toEqual([]);
  });

  it('a branch-raised transfer waits for IT approval; the receiving branch then confirms receipt', async () => {
    const a = await w.asset(w.A.id);
    const r = await createTransfer(w.brA.actor, { fromLocationId: w.A.id, toLocationId: w.C.id, reason: 'Staff moved', assetIds: [a.id] }) as T;
    expect(r.transfer.status).toBe('PENDING_APPROVAL');
    await rejectsWith(decide(w.brA.actor, r.pendingApproval!.id, 'APPROVE'), 403);
    await decide(w.it.actor, r.pendingApproval!.id, 'APPROVE');
    expect((await prisma.transfer.findUniqueOrThrow({ where: { id: r.transfer.id } })).status).toBe('IN_TRANSIT');
    const res = await receive(w.brC.actor, r.transfer.id, { receivedByName: 'Branch C clerk', all: 'RECEIVED' });
    expect(res.received).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).locationId).toBe(w.C.id);
    const mv = await prisma.assetMovement.findFirstOrThrow({ where: { assetId: a.id, kind: 'TRANSFER_RECEIVED' } });
    expect(mv.receivedByName).toBe('Branch C clerk');
  });

  it('rejecting a transfer approval releases the assets', async () => {
    const a = await w.asset(w.A.id);
    const r = await createTransfer(w.brA.actor, { fromLocationId: w.A.id, toLocationId: w.B.id, reason: 'x', assetIds: [a.id] }) as T;
    await rejectsWith(decide(w.it.actor, r.pendingApproval!.id, 'REJECT'), 400, /comment/i);
    await decide(w.it.actor, r.pendingApproval!.id, 'REJECT', 'Not needed');
    expect((await prisma.transfer.findUniqueOrThrow({ where: { id: r.transfer.id } })).status).toBe('REJECTED');
    const again = await createTransfer(w.it.actor, { fromLocationId: w.A.id, toLocationId: w.B.id, reason: 'Now', assetIds: [a.id] }) as T;
    expect(again.transfer.status).toBe('IN_TRANSIT');
  });
});

describe('approval policies', () => {
  let gatedCat: { id: string };
  let it2: Awaited<ReturnType<typeof actorForUser>>;
  beforeAll(async () => {
    gatedCat = await createCategory(w.admin.actor, { name: `Gated ${w.s}` });
    await savePolicy(w.admin.actor, null, { name: `Gated assign ${w.s}`, action: 'ASSIGN', categoryIds: [gatedCat.id], steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'IT_OPERATOR' }] });
    await savePolicy(w.admin.actor, null, { name: `Gated check-in ${w.s}`, action: 'CHECK_IN', categoryIds: [gatedCat.id], steps: [{ stepOrder: 1, approverType: 'ROLE', approverRole: 'IT_OPERATOR' }] });
    const u = await createUser(w.admin.actor, { email: `it2.${w.s}@test.example.com`, name: `IT two ${w.s}`, role: 'IT_OPERATOR', password: PASSWORD, sendInvite: false });
    it2 = await actorForUser(prisma, u.id);
  });
  const gated = () => w.asset(w.A.id, { categoryId: gatedCat.id });

  it('a matching policy holds the action; the requester cannot approve their own request; another approver executes it', async () => {
    const a = await gated();
    const r = await assignAsset(w.it.actor, a.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } });
    expect('pendingApproval' in r).toBe(true);
    const reqId = (r as { pendingApproval: { id: string } }).pendingApproval.id;
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('IN_STOCK');
    await rejectsWith(decide(w.it.actor, reqId, 'APPROVE'), 403, /own request/);
    await decide(it2, reqId, 'APPROVE', 'ok');
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('ASSIGNED');
    expect(after.holderEmployeeId).toBe(w.empA.id);
  });

  it('bulk check-in goes through the same policy as a single check-in', async () => {
    const [a, b] = [await gated(), await gated()];
    // Assign directly as system via approval to reach ASSIGNED.
    for (const x of [a, b]) {
      const r = await assignAsset(w.it.actor, x.id, { holder: { type: 'EMPLOYEE', id: w.empA.id } }) as { pendingApproval: { id: string } };
      await decide(it2, r.pendingApproval.id, 'APPROVE');
    }
    const r = await bulkCheckIn(w.it.actor, [a.id, b.id], { remarks: 'Offboarding' });
    expect('pendingApproval' in r).toBe(true);
    expect((await prisma.asset.findMany({ where: { id: { in: [a.id, b.id] } } })).every((x) => x.status === 'ASSIGNED')).toBe(true);
    await rejectsWith(checkInAsset(w.it.actor, a.id, {}), 409);
    await decide(it2, (r as { pendingApproval: { id: string } }).pendingApproval.id, 'APPROVE');
    expect((await prisma.asset.findMany({ where: { id: { in: [a.id, b.id] } } })).every((x) => x.status === 'IN_STOCK')).toBe(true);
  });
});
