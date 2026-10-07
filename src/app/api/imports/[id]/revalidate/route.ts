import { route } from '@/server/http';
import { revalidateImport } from '@/server/import/engine';

export const POST = route<{ id: string }>({ roles: ['ADMIN', 'IT_OPERATOR'] }, async ({ actor, params }) => revalidateImport(actor, params.id));
