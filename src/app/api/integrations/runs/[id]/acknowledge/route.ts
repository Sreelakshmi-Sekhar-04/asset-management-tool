import { route, body, paging, q, qList } from '@/server/http';
import { acknowledgeRun } from '@/server/services/integrations';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => acknowledgeRun(actor, params.id));
