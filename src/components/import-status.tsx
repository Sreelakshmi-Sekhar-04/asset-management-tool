import { Badge } from './ui';

export const IMPORT_STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: 'Queued', tone: 'gray' }, VALIDATING: { label: 'Dry run running', tone: 'blue' }, VALIDATED: { label: 'Ready to confirm', tone: 'amber' },
  COMMIT_QUEUED: { label: 'Commit queued', tone: 'blue' }, COMMITTING: { label: 'Committing', tone: 'blue' }, COMMITTED: { label: 'Committed', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' }, CANCELLED: { label: 'Cancelled', tone: 'gray' },
};
export const IMPORT_TYPE: Record<string, string> = { ASSETS: 'Assets', EMPLOYEES: 'Employees', BRANCH_USERS: 'Branch users' };
export const ImportStatus = ({ s }: { s: string }) => <Badge tone={IMPORT_STATUS[s]?.tone}>{IMPORT_STATUS[s]?.label ?? s}</Badge>;
export const RUNNING = ['QUEUED', 'VALIDATING', 'COMMIT_QUEUED', 'COMMITTING'];
