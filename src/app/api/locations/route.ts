import { route, body, paging, q, qList } from '@/server/http';
import { createLocation, listLocations, locationInput } from '@/server/services/locations';

export const GET = route({}, async ({ actor, url }) => listLocations(actor, { includeInactive: q(url, 'includeInactive') === 'true', all: q(url, 'all') === 'true' }));
export const POST = route({ roles: ['ADMIN'] }, async ({ req, actor }) => createLocation(actor, await body(req, locationInput)));
