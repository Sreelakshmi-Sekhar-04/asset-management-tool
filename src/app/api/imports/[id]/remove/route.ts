import { z } from 'zod';
import { route, body } from '@/server/http';
import { removeImportRows } from '@/server/import/engine';

/**
 * Takes rows out of this import batch: the listed rows, or every selected row (Delete selected).
 * With restore, puts listed rows back. Never deletes an asset, a location or a department: only the
 * uploaded rows of this batch are affected.
 */
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) => {
  const b = await body(req, z.object({ rows: z.array(z.number().int()).min(1).max(20_000).optional(), selected: z.literal(true).optional(), restore: z.boolean().optional() }));
  return removeImportRows(actor, params.id, b.selected && !b.restore ? 'selected' : b.rows ?? [], !b.restore);
});
