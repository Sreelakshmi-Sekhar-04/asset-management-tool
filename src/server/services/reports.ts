import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { forbidden, notFound } from '@/lib/errors';
import { dateOnly, fmtDateOnly, fmtDateTime, todayIST } from '@/lib/format';
import { label, DISPOSAL_LABEL, HOLDER_TYPE_LABEL, LINE_STATUS_LABEL, MOVEMENT_LABEL, RENEWABLE_TYPE_LABEL, STATUS_LABEL, TRANSFER_STATUS_LABEL, VER_TASK_LABEL } from '@/lib/labels';
import type { Actor } from '../actor';
import type { ExportColumn } from '../export';
import { assetScope, locationScope } from '../scope';
import { getSettings } from '../settings';
import { assetListInclude, assetWhere, listAssets, shapeAsset, type AssetFilters } from './assets';
import { listImports } from '../import/engine';
import { integrationHealth } from './integrations';
import { listRenewables } from './renewables';
import { listExceptions, listTransfers, type TransferFilters } from './transfers';
import { discrepancies, listTasks } from './verification';

/**
 * Standard reports (FR-RPT-02). Each report is one definition used for both the
 * on-screen table and the CSV/Excel export, so an export always equals the rows
 * on screen (TC-RPT-01) and is always scoped to the caller (TC-RPT-08).
 */

type Filters = Record<string, string | string[] | undefined>;
type Page = { skip: number; take: number; sort?: string; dir?: 'asc' | 'desc' };
export interface ReportDef {
  key: string;
  title: string;
  description: string;
  itOnly?: boolean;
  filters: string[];
  columns: ExportColumn[];
  run: (actor: Actor, f: Filters, p: Page) => Promise<{ rows: Record<string, unknown>[]; total: number; summary?: Record<string, unknown> }>;
}

const s = (f: Filters, k: string) => (Array.isArray(f[k]) ? (f[k] as string[])[0] : (f[k] as string | undefined)) || undefined;
const list = (f: Filters, k: string) => { const v = f[k]; if (!v) return undefined; const a = (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean); return a.length ? a : undefined; };
const d = (v: unknown) => (v ? fmtDateOnly(v as Date) : '');
const dt = (v: unknown) => (v ? fmtDateTime(v as Date) : '');

function assetFilters(f: Filters): AssetFilters {
  return {
    search: s(f, 'search'), categoryIds: list(f, 'categoryId'), statuses: list(f, 'status'), locationId: s(f, 'locationId'), holderType: s(f, 'holderType'),
    flag: s(f, 'flag'), warrantyWithinDays: s(f, 'warrantyWithinDays') ? Number(s(f, 'warrantyWithinDays')) : undefined,
  };
}
function transferFilters(f: Filters): TransferFilters {
  return { status: list(f, 'status'), fromLocationId: s(f, 'fromLocationId'), toLocationId: s(f, 'toLocationId'), search: s(f, 'search'), dateFrom: s(f, 'dateFrom'), dateTo: s(f, 'dateTo'), direction: s(f, 'direction') as 'inbound' };
}

const ASSET_COLUMNS: ExportColumn[] = [
  { key: 'assetCode', header: 'Asset ID' }, { key: 'legacyTag', header: 'Legacy tag' }, { key: 'category', header: 'Category' },
  { key: 'make', header: 'Make' }, { key: 'model', header: 'Model' }, { key: 'serialNumber', header: 'Serial number' },
  { key: 'hostname', header: 'Hostname' }, { key: 'ipAddress', header: 'IP address' }, { key: 'location', header: 'Location' },
  { key: 'holder', header: 'Holder' }, { key: 'status', header: 'Status', format: (v) => label(STATUS_LABEL, v as string) },
  { key: 'warrantyEnd', header: 'Warranty end', format: d }, { key: 'flags', header: 'Flags', format: (v) => (v as string[]).join('; ') },
];

export const REPORTS: ReportDef[] = [
  {
    key: 'asset-register', title: 'Asset register', description: 'Every asset with its identifiers, location, holder, status, warranty and flags.',
    filters: ['search', 'categoryId', 'status', 'locationId', 'holderType', 'flag'], columns: ASSET_COLUMNS,
    run: (a, f, p) => listAssets(a, assetFilters(f), p),
  },
  {
    key: 'assets-by-holder', title: 'Assets by branch and holder', description: 'Asset counts per branch and holder, with a status breakdown.',
    filters: ['locationId', 'categoryId', 'status', 'holderType'],
    columns: [
      { key: 'location', header: 'Branch / location' }, { key: 'holderType', header: 'Holder type', format: (v) => (v ? label(HOLDER_TYPE_LABEL, v as string) : 'None (in stock)') },
      { key: 'holder', header: 'Holder' }, { key: 'total', header: 'Assets' }, { key: 'assigned', header: 'Assigned' }, { key: 'inStock', header: 'In stock' }, { key: 'inRepair', header: 'In repair' }, { key: 'retired', header: 'Retired' },
    ],
    run: async (a, f, p) => {
      const where = await assetWhere(a, assetFilters(f));
      const groups = await prisma.asset.groupBy({ by: ['locationId', 'holderType', 'holderEmployeeId', 'holderDepartmentId', 'holderLocationId', 'status'], where, _count: true });
      const m = new Map<string, { locationId: string | null; holderType: string | null; holderId: string | null; total: number; assigned: number; inStock: number; inRepair: number; retired: number }>();
      for (const g of groups) {
        const holderId = g.holderEmployeeId ?? g.holderDepartmentId ?? g.holderLocationId ?? null;
        const k = `${g.locationId}|${g.holderType}|${holderId}`;
        const row = m.get(k) ?? { locationId: g.locationId, holderType: g.holderType, holderId, total: 0, assigned: 0, inStock: 0, inRepair: 0, retired: 0 };
        row.total += g._count;
        if (g.status === 'ASSIGNED') row.assigned += g._count; else if (g.status === 'IN_STOCK') row.inStock += g._count; else if (g.status === 'UNDER_REPAIR') row.inRepair += g._count; else row.retired += g._count;
        m.set(k, row);
      }
      const all = [...m.values()];
      const locIds = [...new Set(all.flatMap((r) => [r.locationId, r.holderType === 'LOCATION' ? r.holderId : null]).filter((x): x is string => !!x))];
      const [locs, emps, depts] = await Promise.all([
        prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, namePath: true } }),
        prisma.employee.findMany({ where: { id: { in: all.filter((r) => r.holderType === 'EMPLOYEE').map((r) => r.holderId!) } }, select: { id: true, name: true, employeeCode: true } }),
        prisma.department.findMany({ where: { id: { in: all.filter((r) => r.holderType === 'DEPARTMENT').map((r) => r.holderId!) } }, select: { id: true, name: true } }),
      ]);
      const ln = new Map(locs.map((l) => [l.id, l.namePath]));
      const en = new Map(emps.map((e) => [e.id, `${e.name} (${e.employeeCode})`]));
      const dn = new Map(depts.map((x) => [x.id, x.name]));
      const rows = all
        .map((r) => ({ ...r, location: ln.get(r.locationId ?? '') ?? '—', holder: !r.holderId ? '' : r.holderType === 'EMPLOYEE' ? en.get(r.holderId) : r.holderType === 'DEPARTMENT' ? dn.get(r.holderId) : ln.get(r.holderId) }))
        .sort((x, y) => x.location.localeCompare(y.location) || (x.holder ?? '').localeCompare(y.holder ?? ''));
      return { rows: rows.slice(p.skip, p.skip + p.take), total: rows.length, summary: { assets: rows.reduce((n, r) => n + r.total, 0) } };
    },
  },
  {
    key: 'transfer-register', title: 'Transfer register', description: 'Every transfer with route, reason, requester, approver, dates and line results.',
    filters: ['status', 'fromLocationId', 'toLocationId', 'dateFrom', 'dateTo', 'search'],
    columns: [
      { key: 'transferNo', header: 'Transfer' }, { key: 'from', header: 'From' }, { key: 'to', header: 'To' }, { key: 'reason', header: 'Reason' },
      { key: 'status', header: 'Status', format: (v) => label(TRANSFER_STATUS_LABEL, v as string) }, { key: 'requestedBy', header: 'Requested by' },
      { key: 'requestedAt', header: 'Requested', format: d }, { key: 'effectiveDate', header: 'Effective date', format: d }, { key: 'approver', header: 'Approver' },
      { key: 'approvedAt', header: 'Approved', format: d }, { key: 'completedAt', header: 'Completed', format: d },
      { key: 'counts.total', header: 'Sent' }, { key: 'counts.received', header: 'Received' }, { key: 'counts.rejected', header: 'Not received' }, { key: 'counts.recalled', header: 'Recalled' }, { key: 'counts.pending', header: 'Outstanding' },
    ],
    run: (a, f, p) => listTransfers(a, transferFilters(f), p),
  },
  {
    key: 'in-transit', title: 'In-transit and aging', description: 'Transfers still awaiting receipt, with outstanding lines and days in transit. Rows past the aging threshold are marked.',
    filters: ['fromLocationId', 'toLocationId'],
    columns: [
      { key: 'transferNo', header: 'Transfer' }, { key: 'from', header: 'From' }, { key: 'to', header: 'To' }, { key: 'status', header: 'Status', format: (v) => label(TRANSFER_STATUS_LABEL, v as string) },
      { key: 'approvedAt', header: 'Dispatched', format: d }, { key: 'counts.pending', header: 'Outstanding lines' }, { key: 'counts.total', header: 'Total lines' },
      { key: 'daysInTransit', header: 'Days in transit' }, { key: 'aging', header: 'Aging', format: (v) => (v ? 'Yes' : '') },
    ],
    run: async (a, f, p) => {
      const threshold = (await getSettings()).transferAgingDays;
      const r = await listTransfers(a, { ...transferFilters(f), status: ['IN_TRANSIT', 'PARTIALLY_RECEIVED'] }, { ...p, sort: 'approvedAt', dir: 'asc' });
      return { rows: r.rows.map((x) => ({ ...x, aging: (x.daysInTransit ?? 0) >= threshold })), total: r.total, summary: { agingThresholdDays: threshold } };
    },
  },
  {
    key: 'exceptions', title: 'Transfer exceptions', description: 'Lines marked not received, with owner, age and resolution.',
    filters: ['status'],
    columns: [
      { key: 'line.transfer.transferNo', header: 'Transfer' }, { key: 'line.assetCode', header: 'Asset ID' }, { key: 'line.serialNumber', header: 'Serial' },
      { key: 'line.transfer.fromLocation.namePath', header: 'From' }, { key: 'line.transfer.toLocation.namePath', header: 'To' }, { key: 'reason', header: 'Reason' },
      { key: 'status', header: 'Status' }, { key: 'resolution', header: 'Resolution' }, { key: 'owner', header: 'Owner' }, { key: 'daysOpen', header: 'Days open' }, { key: 'createdAt', header: 'Raised', format: d },
    ],
    run: (a, f, p) => listExceptions(a, { status: s(f, 'status'), ...p }),
  },
  {
    key: 'duplicates', title: 'Duplicates', description: 'Duplicate-suspect pairs with the matched key and the reason recorded at save time.',
    filters: ['key'],
    columns: [
      { key: 'asset.assetCode', header: 'Asset ID' }, { key: 'matchedAsset.assetCode', header: 'Matches' }, { key: 'key', header: 'Matched key' }, { key: 'value', header: 'Value' },
      { key: 'reason', header: 'Reason recorded' }, { key: 'createdAt', header: 'Flagged', format: d }, { key: 'asset.location.namePath', header: 'Location' },
    ],
    run: async (a, f, p) => {
      const where: Prisma.DuplicateFlagWhereInput = { clearedAt: null, asset: assetScope(a), ...(s(f, 'key') ? { key: s(f, 'key') } : {}) };
      const [rows, total] = await Promise.all([
        prisma.duplicateFlag.findMany({ where, include: { asset: { select: { id: true, assetCode: true, location: { select: { namePath: true } } } }, matchedAsset: { select: { id: true, assetCode: true } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
        prisma.duplicateFlag.count({ where }),
      ]);
      return { rows, total };
    },
  },
  {
    key: 'retired', title: 'Retired assets', description: 'Retired assets with reason, disposal type, date and actor.',
    filters: ['categoryId', 'locationId', 'disposalType', 'dateFrom', 'dateTo'],
    columns: [
      { key: 'assetCode', header: 'Asset ID' }, { key: 'category', header: 'Category' }, { key: 'make', header: 'Make' }, { key: 'model', header: 'Model' }, { key: 'serialNumber', header: 'Serial' },
      { key: 'location', header: 'Last location' }, { key: 'retireReason', header: 'Reason' }, { key: 'disposalType', header: 'Disposal', format: (v) => label(DISPOSAL_LABEL, v as string) },
      { key: 'retiredAt', header: 'Retired on', format: d }, { key: 'retiredBy', header: 'Retired by' },
    ],
    run: async (a, f, p) => {
      const base = await assetWhere(a, { ...assetFilters(f), statuses: ['RETIRED'] });
      const and: Prisma.AssetWhereInput[] = [base];
      if (s(f, 'disposalType')) and.push({ disposalType: s(f, 'disposalType') as 'SCRAPPED' });
      if (s(f, 'dateFrom')) and.push({ retiredAt: { gte: dateOnly(s(f, 'dateFrom')!) } });
      if (s(f, 'dateTo')) and.push({ retiredAt: { lt: new Date(dateOnly(s(f, 'dateTo')!).getTime() + 86_400_000) } });
      const where = { AND: and };
      const [rows, total] = await Promise.all([
        prisma.asset.findMany({ where, include: assetListInclude, orderBy: [{ retiredAt: 'desc' }, { id: 'asc' }], skip: p.skip, take: p.take }),
        prisma.asset.count({ where }),
      ]);
      const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.retiredById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
      const un = new Map(users.map((u) => [u.id, u.name]));
      return { rows: rows.map((r) => ({ ...shapeAsset(r), retiredBy: un.get(r.retiredById ?? '') ?? '' })), total };
    },
  },
  {
    key: 'movements', title: 'Asset movement history', description: 'Every movement with kind, from, to, effective date and actor. Filter to one asset or a location.',
    filters: ['assetCode', 'locationId', 'kind', 'dateFrom', 'dateTo'],
    columns: [
      { key: 'asset.assetCode', header: 'Asset ID' }, { key: 'kind', header: 'Kind', format: (v) => label(MOVEMENT_LABEL, v as string) },
      { key: 'fromLocationName', header: 'From location' }, { key: 'toLocationName', header: 'To location' }, { key: 'fromHolderName', header: 'From holder' }, { key: 'toHolderName', header: 'To holder' },
      { key: 'fromStatus', header: 'From status', format: (v) => (v ? label(STATUS_LABEL, v as string) : '') }, { key: 'toStatus', header: 'To status', format: (v) => (v ? label(STATUS_LABEL, v as string) : '') },
      { key: 'effectiveAt', header: 'Effective date', format: d }, { key: 'recordedAt', header: 'Recorded', format: dt }, { key: 'actorName', header: 'Actor' },
      { key: 'transferNo', header: 'Transfer' }, { key: 'approverName', header: 'Approver' }, { key: 'receivedByName', header: 'Received by' }, { key: 'reason', header: 'Reason' },
    ],
    run: async (a, f, p) => {
      const and: Prisma.AssetMovementWhereInput[] = [{ asset: assetScope(a) }];
      if (s(f, 'assetCode')) and.push({ asset: { assetCode: s(f, 'assetCode')!.toUpperCase() } });
      if (s(f, 'kind')) and.push({ kind: s(f, 'kind') as 'TRANSFER_RECEIVED' });
      if (s(f, 'locationId')) {
        const loc = await prisma.location.findUnique({ where: { id: s(f, 'locationId') }, select: { idPath: true } });
        const ids = (await prisma.location.findMany({ where: { idPath: { startsWith: loc?.idPath ?? '/__none__/' } }, select: { id: true } })).map((l) => l.id);
        and.push({ OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] });
      }
      if (s(f, 'dateFrom')) and.push({ effectiveAt: { gte: dateOnly(s(f, 'dateFrom')!) } });
      if (s(f, 'dateTo')) and.push({ effectiveAt: { lt: new Date(dateOnly(s(f, 'dateTo')!).getTime() + 86_400_000) } });
      // Branch users see movements touching their scope only.
      if (a.role === 'BRANCH_USER') {
        const ids = (await prisma.location.findMany({ where: locationScope(a), select: { id: true } })).map((l) => l.id);
        and[0] = { OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }] };
      }
      const where = { AND: and };
      const [rows, total] = await Promise.all([
        prisma.assetMovement.findMany({ where, include: { asset: { select: { id: true, assetCode: true } } }, orderBy: [{ effectiveAt: 'desc' }, { recordedAt: 'desc' }], skip: p.skip, take: p.take }),
        prisma.assetMovement.count({ where }),
      ]);
      const trs = await prisma.transfer.findMany({ where: { id: { in: rows.map((r) => r.transferId).filter((x): x is string => !!x) } }, select: { id: true, transferNo: true } });
      const tn = new Map(trs.map((t) => [t.id, t.transferNo]));
      return { rows: rows.map((r) => ({ ...r, transferNo: tn.get(r.transferId ?? '') ?? '' })), total };
    },
  },
  {
    key: 'expiry-outlook', title: 'Expiry outlook', description: 'Warranties, licences and other renewables expiring soon, sorted by urgency.',
    filters: ['withinDays', 'type', 'locationId', 'expired'],
    columns: [
      { key: 'asset.assetCode', header: 'Asset ID' }, { key: 'type', header: 'Type', format: (v) => label(RENEWABLE_TYPE_LABEL, v as string) }, { key: 'label', header: 'Item' },
      { key: 'vendor', header: 'Vendor' }, { key: 'expiryDate', header: 'Expires', format: d }, { key: 'daysRemaining', header: 'Days remaining' },
      { key: 'asset.location.namePath', header: 'Location' }, { key: 'owner', header: 'Owner' }, { key: 'reminderState', header: 'Reminders' }, { key: 'source', header: 'Source' },
    ],
    run: (a, f, p) => listRenewables(a, { withinDays: s(f, 'expired') ? undefined : Number(s(f, 'withinDays') ?? 90), expired: s(f, 'expired') === 'true', type: list(f, 'type'), locationId: s(f, 'locationId'), status: ['ACTIVE', 'EXPIRED'] }, { ...p, sort: 'expiryDate', dir: 'asc' }),
  },
  {
    key: 'renewables', title: 'Renewables register', description: 'Every renewable in scope with the same filters as the Renewals screen.',
    filters: ['search', 'type', 'status', 'locationId', 'withinDays', 'expired', 'assetId'],
    columns: [
      { key: 'asset.assetCode', header: 'Asset ID' }, { key: 'type', header: 'Type', format: (v) => label(RENEWABLE_TYPE_LABEL, v as string) }, { key: 'label', header: 'Item' },
      { key: 'vendor', header: 'Vendor' }, { key: 'identifier', header: 'Key / contract' }, { key: 'startDate', header: 'Starts', format: d }, { key: 'expiryDate', header: 'Expires', format: d },
      { key: 'daysRemaining', header: 'Days remaining' }, { key: 'status', header: 'Status' }, { key: 'cost', header: 'Cost (INR)' }, { key: 'critical', header: 'Critical', format: (v) => (v ? 'Yes' : '') },
      { key: 'asset.location.namePath', header: 'Location' }, { key: 'owner', header: 'Owner' }, { key: 'reminderState', header: 'Reminders' }, { key: 'source', header: 'Source' },
    ],
    run: (a, f, p) => listRenewables(a, { search: s(f, 'search'), type: list(f, 'type'), status: list(f, 'status'), locationId: s(f, 'locationId'), assetId: s(f, 'assetId'), withinDays: s(f, 'withinDays') ? Number(s(f, 'withinDays')) : undefined, expired: s(f, 'expired') === 'true' }, { ...p, sort: 'expiryDate' }),
  },
  {
    key: 'verification-status', title: 'Verification status', description: 'Each branch task per campaign with progress, discrepancies and sign-off.',
    filters: ['campaignId', 'status'],
    columns: [
      { key: 'campaign.name', header: 'Campaign' }, { key: 'location.namePath', header: 'Branch' }, { key: 'status', header: 'Status', format: (v) => label(VER_TASK_LABEL, v as string) },
      { key: 'campaign.dueDate', header: 'Due', format: d }, { key: 'overdue', header: 'Overdue', format: (v) => (v ? 'Yes' : '') },
      { key: 'stats.total', header: 'Lines' }, { key: 'stats.present', header: 'Present' }, { key: 'stats.missing', header: 'Missing' }, { key: 'stats.wrong', header: 'Wrong details' },
      { key: 'stats.unmarked', header: 'Unmarked' }, { key: 'stats.unlisted', header: 'Unlisted found' }, { key: 'submittedAt', header: 'Submitted', format: d }, { key: 'signedOffByName', header: 'Signed off by' }, { key: 'signedOffAt', header: 'Signed off', format: d },
    ],
    run: (a, f, p) => listTasks(a, { campaignId: s(f, 'campaignId'), status: s(f, 'status'), ...p }),
  },
  {
    key: 'verification-discrepancies', title: 'Verification discrepancies', description: 'Missing and wrong-details lines with IT review outcome.',
    filters: ['campaignId', 'review'],
    columns: [
      { key: 'task.campaign.name', header: 'Campaign' }, { key: 'task.location.namePath', header: 'Branch' }, { key: 'assetCode', header: 'Asset ID' },
      { key: 'result', header: 'Result' }, { key: 'note', header: 'Branch note' }, { key: 'reviewStatus', header: 'Review', format: (v) => (v as string) ?? 'Pending' }, { key: 'reviewNote', header: 'Review note' }, { key: 'reviewedAt', header: 'Reviewed', format: d },
    ],
    run: async (a, f, p) => { const r = await discrepancies(a, { campaignId: s(f, 'campaignId'), review: s(f, 'review'), ...p }); return { rows: r.rows, total: r.total, summary: { unlistedFound: r.unlisted.length } }; },
  },
  {
    key: 'import-history', title: 'Import history', description: 'Every import with type, mode, counts, status and who ran it.', itOnly: true,
    filters: ['type'],
    columns: [
      { key: 'createdAt', header: 'Started', format: dt }, { key: 'type', header: 'Type' }, { key: 'mode', header: 'Mode' }, { key: 'fileName', header: 'File' }, { key: 'status', header: 'Status' },
      { key: 'totalRows', header: 'Rows' }, { key: 'counts.CREATED', header: 'Created' }, { key: 'counts.UPDATED', header: 'Updated' }, { key: 'counts.UNCHANGED', header: 'Unchanged' }, { key: 'counts.WARNING', header: 'Warnings' }, { key: 'counts.REJECTED', header: 'Rejected' }, { key: 'createdByName', header: 'By' },
    ],
    run: async (a, f, p) => listImports(a, { type: s(f, 'type'), ...p }) as unknown as { rows: Record<string, unknown>[]; total: number },
  },
  {
    key: 'integration-health', title: 'Integration health', description: 'Per source: last successful run, counts, unmatched queue and errors.', itOnly: true,
    filters: [],
    columns: [
      { key: 'name', header: 'Source' }, { key: 'kind', header: 'Kind' }, { key: 'lastSuccessAt', header: 'Last successful run', format: dt }, { key: 'lastRunStatus', header: 'Last run status' },
      { key: 'lastRun.received', header: 'Received' }, { key: 'lastRun.created', header: 'Created' }, { key: 'lastRun.updated', header: 'Updated' }, { key: 'lastRun.conflicts', header: 'Conflicts' }, { key: 'lastRun.rejected', header: 'Rejected' },
      { key: 'unmatchedOpen', header: 'Unmatched queue' }, { key: 'conflictsOpen', header: 'Open conflicts' }, { key: 'unacknowledgedErrors', header: 'Unacknowledged failed runs', format: (v) => (v as unknown[]).length },
    ],
    run: async (a, _f, p) => { const rows = await integrationHealth(a); return { rows: rows.slice(p.skip, p.skip + p.take), total: rows.length }; },
  },
];

export function reportList(actor: Actor) {
  return REPORTS.filter((r) => !r.itOnly || actor.role !== 'BRANCH_USER').map(({ key, title, description, filters, columns }) => ({ key, title, description, filters, columns: columns.map((c) => ({ key: c.key, header: c.header })) }));
}

export function getReport(actor: Actor, key: string) {
  const r = REPORTS.find((x) => x.key === key);
  if (!r) throw notFound('Report');
  if (r.itOnly && actor.role === 'BRANCH_USER') throw forbidden();
  return r;
}

export async function runReport(actor: Actor, key: string, f: Filters, p: Page) {
  const r = getReport(actor, key);
  const res = await r.run(actor, f, p);
  return { key: r.key, title: r.title, columns: r.columns.map((c) => ({ key: c.key, header: c.header })), rows: res.rows.map((row) => ({ ...row, _cells: r.columns.map((c) => cellText(c, row)) })), total: res.total, summary: res.summary ?? null, asOf: todayIST() };
}

/** All rows (up to the export cap) for an export identical to the on-screen report. */
export async function reportRowsForExport(actor: Actor, key: string, f: Filters, sort?: string, dir?: 'asc' | 'desc') {
  const r = getReport(actor, key);
  const res = await r.run(actor, f, { skip: 0, take: 100_000, sort, dir });
  return { def: r, rows: res.rows };
}

function cellText(c: ExportColumn, row: Record<string, unknown>) {
  const v = c.key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], row);
  if (c.format) return c.format(v, row);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDateOnly(v);
  return typeof v === 'object' ? JSON.stringify(v) : (v as string | number);
}

