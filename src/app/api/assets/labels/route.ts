import { route } from '@/server/http';
import { fileResponse } from '@/server/export';
import { labelsPdf } from '@/server/pdf';

/** Labels PDF. ?inline=1 opens it in the browser's viewer for preview and printing. */
export const POST = route({}, async ({ req, actor, url }) => {
  const f = await labelsPdf(actor, await req.json().catch(() => ({})));
  const res = fileResponse(f);
  if (url.searchParams.get('inline') === '1') res.headers.set('content-disposition', `inline; filename="${f.file}"`);
  return res;
});
