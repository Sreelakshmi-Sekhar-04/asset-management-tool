import { route, body, paging, q, qList } from '@/server/http';
import { dashboard } from '@/server/services/dashboard';

export const GET = route({}, async ({ actor }) => dashboard(actor));
