import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { confirmImport } from '@/server/import/engine';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => confirmImport(actor, params.id, (await body(req, z.object({ warningReason: z.string().max(1000).optional() }))).warningReason));
