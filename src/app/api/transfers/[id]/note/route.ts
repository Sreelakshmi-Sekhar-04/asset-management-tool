import { route, body, paging, q, qList } from '@/server/http';
import { fileResponse } from '@/server/export';
import { transferNotePdf } from '@/server/pdf';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => fileResponse(await transferNotePdf(actor, params.id)));
