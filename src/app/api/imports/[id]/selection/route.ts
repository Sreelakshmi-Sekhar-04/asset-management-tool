import { z } from 'zod';
import { route, body } from '@/server/http';
import { setRowSelection } from '@/server/import/engine';

/** Ticks or unticks preview rows (or all of them); only ticked, valid rows are imported. */
export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) =>
  setRowSelection(actor, params.id, await body(req, z.object({ rows: z.array(z.number().int()).max(20_000).optional(), all: z.boolean().optional(), selected: z.boolean() }))));
