import { route, body, paging, q, qList } from '@/server/http';
import { getImport } from '@/server/import/engine';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => getImport(actor, params.id));
