import { route, q } from '@/server/http';
import { assetQr } from '@/server/pdf';

/** The asset's QR code: ?format=svg (default, shown on screen) or png (?download=1 to save it). */
export const GET = route<{ id: string }>({}, async ({ actor, params, url }) => {
  const f = await assetQr(actor, params.id, q(url, 'format') === 'png' ? 'png' : 'svg');
  return new Response(new Uint8Array(f.data), {
    headers: { 'content-type': f.mime, 'content-disposition': `${q(url, 'download') ? 'attachment' : 'inline'}; filename="${f.file}"`, 'cache-control': 'private, no-store' },
  });
});
