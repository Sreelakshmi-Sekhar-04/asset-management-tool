import { route } from '@/server/http';
import { updateOrganization } from '@/server/services/organizations';

/** Rename, activate or deactivate an organization. */
export const PATCH = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => updateOrganization(actor, params.id, await req.json()));
