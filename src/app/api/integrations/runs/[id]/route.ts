import { route, body, paging, q, qList } from '@/server/http';
import { getRun } from '@/server/services/integrations';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => getRun(actor, params.id));
