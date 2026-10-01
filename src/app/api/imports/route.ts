import { route, body, paging, q, qList } from '@/server/http';
import { badRequest } from '@/lib/errors';
import { listImports, startImport } from '@/server/import/engine';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, url }) => listImports(actor, { type: q(url, 'type'), ...paging(url) }));

export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => {
  const form = await req.formData().catch(() => { throw badRequest('Send the file as multipart/form-data.'); });
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('Choose a CSV or Excel file.');
  const type = String(form.get('type') ?? '');
  if (!['ASSETS', 'EMPLOYEES', 'BRANCH_USERS'].includes(type)) throw badRequest('Choose what to import.');
  const mode = String(form.get('mode') ?? 'CREATE_ONLY');
  if (mode !== 'CREATE_ONLY' && mode !== 'CREATE_OR_UPDATE') throw badRequest('Unknown import mode.');
  return startImport(actor, { type: type as 'ASSETS', mode, createMissing: form.get('createMissing') === 'true', fileName: file.name, data: Buffer.from(await file.arrayBuffer()) });
});
