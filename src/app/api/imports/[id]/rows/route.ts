import { route, body, paging, q, qList } from '@/server/http';
import { importRows } from '@/server/import/engine';

export const GET = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params, url }) => importRows(actor, params.id, { outcome: q(url, 'outcome'), ...paging(url) }));
