import { route, body, paging, q, qList } from '@/server/http';
import { removeUnlisted } from '@/server/services/verification';

export const DELETE = route<{ id: string; uid: string }>({}, async ({ actor, params }) => removeUnlisted(actor, params.id, params.uid));
