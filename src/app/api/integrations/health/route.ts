import { route, body, paging, q, qList } from '@/server/http';
import { integrationHealth } from '@/server/services/integrations';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor }) => integrationHealth(actor));
