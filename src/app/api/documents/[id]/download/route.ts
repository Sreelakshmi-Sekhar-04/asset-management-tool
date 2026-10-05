import { route, body, paging, q, qList } from '@/server/http';
import { downloadDocument } from '@/server/services/documents';

export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => {
  const { doc, data } = await downloadDocument(actor, params.id);
  const inline = q(url, 'inline') === 'true' && /^(image\/|application\/pdf)/.test(doc.mimeType);
  return new Response(new Uint8Array(data), { headers: { 'content-type': doc.mimeType, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(doc.fileName)}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});
