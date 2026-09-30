import { Badge } from './ui';

const RUN_TONE: Record<string, string> = { RUNNING: 'blue', SUCCESS: 'green', PARTIAL: 'amber', FAILED: 'red', DUPLICATE: 'gray' };
const RUN_LABEL: Record<string, string> = { RUNNING: 'Running', SUCCESS: 'Success', PARTIAL: 'Partial', FAILED: 'Failed', DUPLICATE: 'Duplicate batch (skipped)' };
export const RunStatus = ({ s }: { s: string | null }) => (s ? <Badge tone={RUN_TONE[s]}>{RUN_LABEL[s] ?? s}</Badge> : <Badge>No runs</Badge>);
export const FIELD_LABEL: Record<string, string> = { hostname: 'Hostname', ipAddress: 'IP address', macAddress: 'MAC address', warrantyEnd: 'Warranty end', name: 'Name', email: 'Email', departmentId: 'Department', managerId: 'Manager', active: 'Active' };
export const RULE_LABEL: Record<string, string> = { OVERWRITE: 'Source wins (overwrite)', WARN: 'Queue a conflict for review', IGNORE: 'Ignore incoming value' };
export interface RunCounts { received: number; created: number; updated: number; unchanged?: number; conflicts: number; rejected: number; unmatched: number }
export const countsText = (c: RunCounts | null | undefined) => (c ? `${c.received} received · ${c.created} created · ${c.updated} updated · ${c.conflicts} conflicts · ${c.unmatched} unmatched · ${c.rejected} rejected` : '—');
