import { route } from '@/server/http';
import { submitTask } from '@/server/services/verification';

export const POST = route<{ id: string }>({}, async ({ actor, params }) => submitTask(actor, params.id));
