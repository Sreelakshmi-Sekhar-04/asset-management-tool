import { route, body, paging, q, qList } from '@/server/http';
import { getTask } from '@/server/services/verification';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => getTask(actor, params.id));
