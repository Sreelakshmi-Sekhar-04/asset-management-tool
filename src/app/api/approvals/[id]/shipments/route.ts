import { route } from '@/server/http';
import { shipmentsForRequest } from '@/server/services/transfer-receipt';

/** An approved transfer's shipments: what is in transit, what was received and in what condition. */
export const GET = route<{ id: string }>({}, async ({ actor, params }) => shipmentsForRequest(actor, params.id));
