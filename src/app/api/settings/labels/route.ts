import { route } from '@/server/http';
import { updateLabelSettings } from '@/server/services/asset-id';

export const PUT = route({ roles: ['ADMIN'] }, async ({ req, actor }) => updateLabelSettings(actor, await req.json()));
