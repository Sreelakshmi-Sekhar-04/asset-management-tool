import { z } from 'zod';
import { route, body } from '@/server/http';
import { replaceImportValue } from '@/server/import/engine';

/** Points rows at a location or department added from the preview under another name. */
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) =>
  replaceImportValue(actor, params.id, await body(req, z.object({ field: z.enum(['location', 'department']), from: z.string().min(1).max(500), to: z.string().min(1).max(500) }))));
