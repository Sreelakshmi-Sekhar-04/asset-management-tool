import { route, body, paging, q, qList } from '@/server/http';
import { campaignDashboard } from '@/server/services/verification';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => campaignDashboard(actor, params.id));
