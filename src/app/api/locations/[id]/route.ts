import { route, body, paging, q, qList } from '@/server/http';
import { updateLocation, locationInput } from '@/server/services/locations';

export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => updateLocation(actor, params.id, await body(req, locationInput.partial().extend({ active: (await import('zod')).z.boolean().optional() }))));
