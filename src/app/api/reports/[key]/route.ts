import { route, body, paging, q, qList } from '@/server/http';
import { buildExport, fileResponse } from '@/server/export';
import { reportRowsForExport, runReport } from '@/server/services/reports';

const RESERVED = new Set(['page', 'pageSize', 'sort', 'dir', 'format']);

export const GET = route<{ key: string }>({}, async ({ actor, params, url }) => {
  const filters: Record<string, string | string[]> = {};
  for (const k of new Set(url.searchParams.keys())) {
    if (RESERVED.has(k)) continue;
    const all = url.searchParams.getAll(k).filter(Boolean);
    if (all.length) filters[k] = all.length === 1 ? all[0] : all;
  }
  const format = q(url, 'format');
  const p = paging(url);
  if (format === 'csv' || format === 'xlsx') {
    const { def, rows } = await reportRowsForExport(actor, params.key, filters, p.sort, url.searchParams.get('dir') === 'asc' ? 'asc' : url.searchParams.get('dir') === 'desc' ? 'desc' : undefined);
    return fileResponse(await buildExport(actor, { name: def.title, columns: def.columns, rows, format, filters }));
  }
  return runReport(actor, params.key, filters, { ...p, dir: url.searchParams.get('dir') === 'asc' ? 'asc' : url.searchParams.get('dir') === 'desc' ? 'desc' : undefined });
});
