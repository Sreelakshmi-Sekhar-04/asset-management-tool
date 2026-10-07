import { route, body } from '@/server/http';
import { z } from 'zod';
import { confirmImport } from '@/server/import/engine';

/** Imports the selected, valid rows; `expected` is the number the preview showed, re-checked first. */
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => {
  const b = await body(req, z.object({ warningReason: z.string().max(1000).optional(), expected: z.number().int().min(0).optional() }));
  return confirmImport(actor, params.id, b.warningReason, b.expected);
});
