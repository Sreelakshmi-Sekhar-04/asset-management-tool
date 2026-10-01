import { route, body, paging, q, qList } from '@/server/http';
import { restoreDocument } from '@/server/services/documents';

export const POST = route<{ id: string }>({ roles: ['ADMIN'] }, async ({ actor, params }) => restoreDocument(actor, params.id));
