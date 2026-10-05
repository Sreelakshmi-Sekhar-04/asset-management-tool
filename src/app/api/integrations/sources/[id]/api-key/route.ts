import { route, body, paging, q, qList } from '@/server/http';
import { issueApiKey, revokeApiKey } from '@/server/services/integrations';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => issueApiKey(actor, params.id));
export const DELETE = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => revokeApiKey(actor, params.id));
