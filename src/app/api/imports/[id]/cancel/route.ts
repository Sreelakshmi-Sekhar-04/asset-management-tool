import { route, body, paging, q, qList } from '@/server/http';
import { cancelImport } from '@/server/import/engine';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => cancelImport(actor, params.id));
