import { route, body, paging, q, qList } from '@/server/http';
import { getRequest } from '@/server/services/approvals';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getRequest(actor, params.id));
