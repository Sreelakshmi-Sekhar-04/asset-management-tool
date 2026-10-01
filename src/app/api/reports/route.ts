import { route, body, paging, q, qList } from '@/server/http';
import { reportList } from '@/server/services/reports';

export const GET = route({}, async ({ actor }) => reportList(actor));
