import { z } from 'zod';
import { route, body } from '@/server/http';
import { editImportRow } from '@/server/import/engine';

/** Correct one row of an asset dry run in the preview; the whole file is checked again. */
export const PATCH = route<{ id: string; row: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ req, actor, params }) =>
  editImportRow(actor, params.id, Number(params.row), (await body(req, z.object({ data: z.record(z.string(), z.string().max(500)) }))).data));
