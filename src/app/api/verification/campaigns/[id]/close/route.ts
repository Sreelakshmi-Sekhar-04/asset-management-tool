import { route, body, paging, q, qList } from '@/server/http';
import { closeCampaign } from '@/server/services/verification';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => closeCampaign(actor, params.id));
