import { NextResponse } from 'next/server';
import { publicRoute, clientIp } from '@/server/http';
import { badRequest } from '@/lib/errors';
import { authenticateSource, processBatch } from '@/server/services/integrations';

/**
 * Vendor-neutral inbound device hook (FR-INT-02). Authenticate with
 * `Authorization: Bearer <api key>` issued for the source. Returns 202 with counts.
 */
export const POST = publicRoute<{ source: string }>(async ({ req, params }) => {
  const source = await authenticateSource(params.source, req.headers.get('authorization'), clientIp(req));
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 20 * 1024 * 1024) throw badRequest('Payload too large (max 20 MB).');
  let payload: unknown;
  try { payload = await req.json(); } catch { throw badRequest('Body must be JSON: {"batchId": "...", "records": [...]}'); }
  const result = await processBatch(source, payload, { mode: 'PUSH' });
  return NextResponse.json(result, { status: 202 });
});
