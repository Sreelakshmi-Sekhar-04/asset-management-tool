import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { resolveConflict } from '@/server/services/integrations';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => resolveConflict(actor, params.id, (await body(req, z.object({ decision: z.enum(['ACCEPT_INCOMING', 'KEEP_CURRENT']) }))).decision));
