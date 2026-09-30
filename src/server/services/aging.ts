import { prisma } from '@/lib/db';
import { dateOnly, fmtDateOnly, todayIST } from '@/lib/format';
import { branchUserIdsFor, itUserIds, notifyUsers } from '../notify';
import { getSettings } from '../settings';

/**
 * FR-TRF-11: transfers in transit longer than the configured threshold (FR-CFG-08,
 * default 7 days) remind the receiver, the sender and IT. One reminder per transfer
 * per week of aging (deduplicated by event key), so a stuck transfer keeps surfacing
 * without flooding inboxes.
 */
export async function runTransferAging(asOf: string = todayIST()) {
  const { transferAgingDays } = await getSettings();
  const today = dateOnly(asOf);
  const cutoff = new Date(today.getTime() - transferAgingDays * 86_400_000 + 86_400_000);
  const aging = await prisma.transfer.findMany({
    where: { status: { in: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'] }, approvedAt: { lt: cutoff } },
    include: { fromLocation: { select: { id: true, namePath: true } }, toLocation: { select: { id: true, namePath: true } } },
  });
  const it = await itUserIds(prisma);
  let sent = 0;
  for (const t of aging) {
    const days = Math.floor((today.getTime() - dateOnly(t.approvedAt!.toISOString().slice(0, 10)).getTime()) / 86_400_000);
    if (days < transferAgingDays) continue;
    const outstanding = await prisma.transferLine.count({ where: { transferId: t.id, status: 'IN_TRANSIT' } });
    if (!outstanding) continue;
    const week = Math.floor((days - transferAgingDays) / 7);
    const recipients = [...(await branchUserIdsFor(prisma, t.toLocationId)), ...(await branchUserIdsFor(prisma, t.fromLocationId)), t.requestedById, ...it];
    await notifyUsers(prisma, recipients, {
      type: 'TRANSFER_AGING',
      title: `${t.transferNo} in transit for ${days} days`,
      body: `${t.transferNo} from ${t.fromLocation.namePath} to ${t.toLocation.namePath} was dispatched on ${fmtDateOnly(t.approvedAt!)} and still has ${outstanding} line(s) awaiting receipt (threshold ${transferAgingDays} days).`,
      link: `/transfers/${t.id}`,
      eventKey: `transfer-aging:${t.id}:w${week}`,
    });
    sent++;
  }
  return { aging: aging.length, reminded: sent };
}
