import { route, body, paging, q, qList } from '@/server/http';
import { cancelRequest } from '@/server/services/approvals';

export const POST = route<{ id: string }>({}, async ({ actor, params }) => cancelRequest(actor, params.id));
