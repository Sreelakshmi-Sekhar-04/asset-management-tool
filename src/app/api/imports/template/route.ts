import { route, body, paging, q, qList } from '@/server/http';
import { badRequest } from '@/lib/errors';
import { templateFile } from '@/server/import/templates';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ url }) => {
  const type = q(url, 'type') ?? 'ASSETS';
  if (!['ASSETS', 'EMPLOYEES', 'BRANCH_USERS'].includes(type)) throw badRequest('Unknown template.');
  const f = await templateFile(type as 'ASSETS', q(url, 'format') === 'xlsx' ? 'xlsx' : 'csv');
  return new Response(new Uint8Array(f.data), { headers: { 'content-type': f.mime, 'content-disposition': `attachment; filename="${f.name}"` } });
});
