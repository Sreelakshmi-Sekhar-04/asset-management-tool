import { route, body, paging, q, qList } from '@/server/http';
import { auditActions } from '@/server/services/audit-query';

export const GET = route({ roles: ['ADMIN', 'IT_OPERATOR'] }, async () => auditActions());
