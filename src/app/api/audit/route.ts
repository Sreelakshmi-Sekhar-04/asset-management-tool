import { route, body, paging, q, qList } from '@/server/http';
import { prisma } from '@/lib/db';
import { fmtDateTime } from '@/lib/format';
import { buildExport, fileResponse } from '@/server/export';
import { auditWhere, listAudit, type AuditFilters } from '@/server/services/audit-query';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, url }) => {
  const f: AuditFilters = { entityType: q(url, 'entityType'), entityId: q(url, 'entityId'), entityLabel: q(url, 'entityLabel'), actor: q(url, 'actor'), action: q(url, 'action'), dateFrom: q(url, 'dateFrom'), dateTo: q(url, 'dateTo') };
  const format = q(url, 'format');
  if (format === 'csv' || format === 'xlsx') {
    const rows = await prisma.auditLog.findMany({ where: await auditWhere(actor, f), orderBy: { at: 'desc' }, take: 100_000 });
    return fileResponse(await buildExport(actor, {
      name: 'Audit log', format, filters: f, rows: rows.map((r) => ({ ...r, id: r.id.toString() })),
      columns: [
        { key: 'at', header: 'When (IST)', format: (v) => fmtDateTime(v as Date) }, { key: 'actorEmail', header: 'Actor' }, { key: 'actorRole', header: 'Role' }, { key: 'action', header: 'Action' },
        { key: 'entityType', header: 'Entity' }, { key: 'entityLabel', header: 'Record' }, { key: 'details', header: 'Details' }, { key: 'before', header: 'Before' }, { key: 'after', header: 'After' }, { key: 'ip', header: 'IP' },
      ],
    }));
  }
  return listAudit(actor, f, paging(url));
});
