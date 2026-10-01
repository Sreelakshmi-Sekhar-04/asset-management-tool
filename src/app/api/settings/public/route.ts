import { publicRoute } from '@/server/http';
import { publicSettings } from '@/server/services/master';

export const GET = publicRoute(async () => publicSettings());
