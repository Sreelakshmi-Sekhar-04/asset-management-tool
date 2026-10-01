import { route, body, paging, q, qList } from '@/server/http';
import { importReportCsv } from '@/server/import/engine';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => {
  const f = await importReportCsv(actor, params.id);
  return new Response(new Uint8Array(f.data), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${f.name}"` } });
});
