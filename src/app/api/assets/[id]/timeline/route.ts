import { route, body, paging, q, qList } from '@/server/http';
import { assetTimeline } from '@/server/services/history';

export const GET = route<{ id: string }>({}, async ({ actor, params }) => assetTimeline(actor, params.id));
