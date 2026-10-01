import { route } from '@/server/http';
import { correctLocationHolder } from '@/server/services/assets';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ req, actor, params }) => correctLocationHolder(actor, params.id, await req.json()));
