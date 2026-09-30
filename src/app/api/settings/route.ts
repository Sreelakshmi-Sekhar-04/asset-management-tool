import { route, body, paging, q, qList } from '@/server/http';
import { getSettings } from '@/server/settings';
import { updateSettings } from '@/server/services/master';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async () => getSettings());
export const PATCH = route({ roles: ['ADMIN'] }, async ({ req, actor }) => updateSettings(actor, await req.json()));
