import { route } from '@/server/http';
import { markAllPresent } from '@/server/services/verification';

export const POST = route<{ id: string }>({}, async ({ actor, params }) => markAllPresent(actor, params.id));
