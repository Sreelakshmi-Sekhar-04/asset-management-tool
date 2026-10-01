import { route, body, paging, q, qList } from '@/server/http';
import { deleteSavedFilter } from '@/server/services/notifications';

export const DELETE = route<{ id: string }>({}, async ({ actor, params }) => deleteSavedFilter(actor, params.id));
