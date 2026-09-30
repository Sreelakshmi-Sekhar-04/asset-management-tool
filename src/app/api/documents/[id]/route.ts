import { route, body, paging, q, qList } from '@/server/http';
import { z } from 'zod';
import { deleteDocument } from '@/server/services/documents';

export const DELETE = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => deleteDocument(actor, params.id, (await body(req, z.object({ reason: z.string().trim().min(1, 'A reason is required').max(1000) }))).reason));
