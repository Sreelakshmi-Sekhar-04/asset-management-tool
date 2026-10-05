import { prisma } from '@/lib/db';
import { dateOnly, todayIST } from '@/lib/format';
import type { Actor } from '../actor';
import { assetScope, locationScope } from '../scope';
import { getSettings } from '../settings';
import { assetWhere } from './assets';
import { inboxCounts } from './approvals';
import { renewableWhere } from './renewables';
import { transferWhere } from './transfers';
import { listCampaigns } from './verification';

/**
 * Dashboard (FR-RPT-01). Every tile is computed with the same where-builders as the
 * report or list it links to, so each count reconciles exactly (TC-RPT-06), and every
 * query is scoped to the caller (TC-RPT-07).
 */
export async function dashboard(actor: Actor) {
  const scope = assetScope(actor);
  const today = dateOnly(todayIST());
  const [byStatus, byCategoryRaw, flags, openTransfers, inTransit, exceptions, approvals, settings] = await Promise.all([
    prisma.asset.groupBy({ by: ['status'], where: scope, _count: true }),
    prisma.asset.groupBy({ by: ['categoryId'], where: { AND: [scope, { status: { not: 'RETIRED' } }] }, _count: true }),
    Promise.all([
      prisma.asset.count({ where: { AND: [scope, { flagTransferException: true }] } }),
      prisma.asset.count({ where: { AND: [scope, { flagMissing: true }] } }),
      prisma.asset.count({ where: { AND: [scope, { flagDuplicateSuspect: true }] } }),
    ]),
    transferWhere(actor, { status: ['PENDING_APPROVAL', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'] }).then((w) => prisma.transfer.count({ where: w })),
    transferWhere(actor, { status: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'] }).then((w) => prisma.transfer.findMany({ where: w, select: { approvedAt: true } })),
    prisma.transferException.count({ where: { status: 'OPEN', ...(actor.role === 'BRANCH_USER' ? { line: { transfer: { OR: [{ fromLocation: locationScope(actor) }, { toLocation: locationScope(actor) }] } } } : {}) } }),
    actor.role === 'BRANCH_USER'
      ? prisma.approvalRequest.count({ where: { status: 'PENDING', initiatorId: actor.id } }).then((n) => ({ total: n, byAction: {}, mine: true }))
      : inboxCounts(actor).then((c) => ({ ...c, mine: false })),
    getSettings(),
  ]);
  const cats = await prisma.assetCategory.findMany({ where: { id: { in: byCategoryRaw.map((c) => c.categoryId) } }, select: { id: true, name: true } });
  const cn = new Map(cats.map((c) => [c.id, c.name]));

  // By region (IT) or by branch within the user's subtree (branch users).
  const groupDepth = actor.role === 'BRANCH_USER' ? null : 1;
  const locRows = await prisma.$queryRawUnsafe<{ id: string; name: string; path: string; total: bigint; assigned: bigint; in_stock: bigint; repair: bigint }[]>(
    `SELECT g.id, g.name, g."namePath" AS path,
            COUNT(a.id) AS total,
            COUNT(a.id) FILTER (WHERE a.status = 'ASSIGNED') AS assigned,
            COUNT(a.id) FILTER (WHERE a.status = 'IN_STOCK') AS in_stock,
            COUNT(a.id) FILTER (WHERE a.status = 'UNDER_REPAIR') AS repair
       FROM locations g
       JOIN locations l ON l."idPath" LIKE g."idPath" || '%'
       JOIN assets a ON a."locationId" = l.id AND a.status <> 'RETIRED'
      WHERE ${groupDepth === null ? `g."idPath" LIKE $1 || '%' AND (g.type = 'BRANCH' OR g."idPath" = $1)` : `g.depth = 0`}
      GROUP BY g.id, g.name, g."namePath"
      ORDER BY total DESC, g."namePath" ASC
      LIMIT 50`,
    ...(groupDepth === null ? [actor.scopeIdPath ?? '/__none__/'] : []),
  );

  const expiring = await Promise.all([30, 60, 90].map(async (days) => prisma.renewable.count({ where: await renewableWhere(actor, { withinDays: days, status: ['ACTIVE', 'EXPIRED'] }) })));
  const expired = await prisma.renewable.count({ where: await renewableWhere(actor, { expired: true, status: ['ACTIVE', 'EXPIRED'] }) });
  const warranty90 = await prisma.asset.count({ where: await assetWhere(actor, { warrantyWithinDays: 90 }) });

  const campaigns = (await listCampaigns(actor)).filter((c) => c.status === 'ACTIVE').slice(0, 5);

  const aging = inTransit.filter((t) => t.approvedAt && (today.getTime() - dateOnly(t.approvedAt.toISOString().slice(0, 10)).getTime()) / 86_400_000 >= settings.transferAgingDays).length;

  const recent = actor.role === 'BRANCH_USER'
    ? (await prisma.assetMovement.findMany({
        where: { OR: [{ fromLocationId: { in: await scopedIds(actor) } }, { toLocationId: { in: await scopedIds(actor) } }] },
        orderBy: { recordedAt: 'desc' }, take: 12, include: { asset: { select: { assetCode: true } } },
      })).map((m) => ({ at: m.recordedAt, actor: m.actorName, text: `${m.asset.assetCode}: ${m.kind.replace(/_/g, ' ').toLowerCase()}${m.toLocationName ? ` → ${m.toLocationName}` : ''}${m.toHolderName ? ` (${m.toHolderName})` : ''}`, link: `/assets/${m.assetId}` }))
    : (await prisma.auditLog.findMany({ where: { action: { notIn: ['LOGIN', 'LOGOUT', 'SESSION_TIMEOUT', 'EXPORT', 'DOCUMENT_DOWNLOADED'] } }, orderBy: { at: 'desc' }, take: 12 })).map((r) => ({ at: r.at, actor: r.actorEmail, text: `${r.action.replace(/_/g, ' ').toLowerCase()}${r.entityLabel ? `: ${r.entityLabel}` : ''}`, link: r.entityType === 'Asset' && r.entityId ? `/assets/${r.entityId}` : r.entityType === 'Transfer' && r.entityId ? `/transfers/${r.entityId}` : null }));

  const statusCount = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
  return {
    scope: actor.role === 'BRANCH_USER' ? actor.scopeName : 'All locations',
    assets: {
      total: byStatus.reduce((n, x) => n + x._count, 0) - statusCount('RETIRED'),
      assigned: statusCount('ASSIGNED'), inStock: statusCount('IN_STOCK'), underRepair: statusCount('UNDER_REPAIR'), retired: statusCount('RETIRED'),
    },
    byCategory: byCategoryRaw.map((c) => ({ categoryId: c.categoryId, name: cn.get(c.categoryId) ?? '—', count: c._count })).sort((a, b) => b.count - a.count),
    byLocation: locRows.map((r) => ({ id: r.id, name: r.path, total: Number(r.total), assigned: Number(r.assigned), inStock: Number(r.in_stock), underRepair: Number(r.repair) })),
    byLocationLabel: actor.role === 'BRANCH_USER' ? 'By branch' : 'By region',
    flags: { transferException: flags[0], missing: flags[1], duplicateSuspect: flags[2] },
    transfers: { open: openTransfers, inTransit: inTransit.length, aging, agingDays: settings.transferAgingDays },
    exceptionsOpen: exceptions,
    approvals,
    expiring: { d30: expiring[0], d60: expiring[1], d90: expiring[2], expired, warranty90 },
    verification: campaigns,
    recent,
  };
}

async function scopedIds(actor: Actor) {
  return (await prisma.location.findMany({ where: locationScope(actor), select: { id: true } })).map((l) => l.id);
}
