import { route } from '@/server/http';
import { listToReceive } from '@/server/services/transfer-receipt';

/** Approved transfers waiting for the caller to confirm receipt. */
export const GET = route({}, async ({ actor }) => listToReceive(actor));
