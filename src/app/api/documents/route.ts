import { route, body, paging, q, qList } from '@/server/http';
import type { DocumentEntity } from '@prisma/client';
import { badRequest } from '@/lib/errors';
import { listAllDocuments, listDocuments, uploadDocument } from '@/server/services/documents';

const ENTITIES = ['ASSET', 'TRANSFER', 'TRANSFER_RECEIPT', 'RENEWABLE', 'VERIFICATION_TASK', 'ORGANISATION'];

export const GET = route({}, async ({ actor, url }) => {
  const entityType = q(url, 'entityType'), entityId = q(url, 'entityId');
  if (entityType && entityId) {
    if (!ENTITIES.includes(entityType)) throw badRequest('Unknown record type.');
    return { rows: await listDocuments(actor, entityType as DocumentEntity, entityId, q(url, 'includeDeleted') === 'true') };
  }
  return listAllDocuments(actor, { entityType, search: q(url, 'search'), includeDeleted: q(url, 'includeDeleted') === 'true', ...paging(url) });
});

export const POST = route({}, async ({ req, actor }) => {
  const form = await req.formData().catch(() => { throw badRequest('Send the file as multipart/form-data.'); });
  const file = form.get('file');
  const entityType = String(form.get('entityType') ?? ''), entityId = String(form.get('entityId') ?? '');
  if (!(file instanceof File)) throw badRequest('Choose a file to upload.');
  if (!ENTITIES.includes(entityType) || !entityId) throw badRequest('Say which record the file belongs to.');
  return uploadDocument(actor, { entityType: entityType as DocumentEntity, entityId, fileName: file.name, declaredType: file.type, data: Buffer.from(await file.arrayBuffer()), description: String(form.get('description') ?? '') || undefined });
});
