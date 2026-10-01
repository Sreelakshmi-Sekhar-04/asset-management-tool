import { route, body, paging, q, qList } from '@/server/http';
import { runDirectorySync } from '@/server/services/integrations';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => runDirectorySync(actor, params.id));
