import { route, body, paging, q, qList } from '@/server/http';
import { createCampaign, listCampaigns } from '@/server/services/verification';

export const GET = route({}, async ({ actor }) => listCampaigns(actor));
export const POST = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor }) => createCampaign(actor, await req.json()));
