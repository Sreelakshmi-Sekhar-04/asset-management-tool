import { route, body, paging, q, qList } from '@/server/http';
import { updateLocation } from '@/server/services/locations';

export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => updateLocation(actor, params.id, await req.json()));
