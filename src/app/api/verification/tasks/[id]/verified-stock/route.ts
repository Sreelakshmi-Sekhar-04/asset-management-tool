import { route, body, paging, q, qList } from '@/server/http';
import { buildExport, fileResponse } from '@/server/export';
import { verifiedStock } from '@/server/services/verification';

export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => {
  const rows = await verifiedStock(actor, params.id);
  const format = q(url, 'format');
  if (format !== 'csv' && format !== 'xlsx') return { rows };
  return fileResponse(await buildExport(actor, {
    name: 'Verified stock', format, filters: { taskId: params.id }, rows,
    columns: [
      { key: 'assetCode', header: 'Asset ID' }, { key: 'category', header: 'Category' }, { key: 'make', header: 'Make' }, { key: 'model', header: 'Model' },
      { key: 'serialNumber', header: 'Serial' }, { key: 'hostname', header: 'Hostname' }, { key: 'lastVerified', header: 'Verified on' }, { key: 'branch', header: 'Branch' },
      { key: 'campaign', header: 'Campaign' }, { key: 'signedOffBy', header: 'Signed off by' }, { key: 'signedOffAt', header: 'Signed off' },
    ],
  }));
});
