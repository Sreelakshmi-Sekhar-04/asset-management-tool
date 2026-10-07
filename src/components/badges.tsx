import { ASSET_STATUS_LABEL, ASSET_STATUS_TONE, RECEIPT_CONDITION_LABEL } from '@/lib/asset-status';
import { label, LINE_STATUS_LABEL, TRANSFER_STATUS_LABEL, VER_TASK_LABEL } from '@/lib/labels';
import { Badge } from './ui';

const TRF_TONE: Record<string, string> = { DRAFT: 'gray', PENDING_APPROVAL: 'amber', IN_TRANSIT: 'blue', PARTIALLY_RECEIVED: 'purple', COMPLETED: 'green', REJECTED: 'red', CANCELLED: 'gray' };
const LINE_TONE: Record<string, string> = { DRAFT: 'gray', PENDING_APPROVAL: 'amber', IN_TRANSIT: 'blue', RECEIVED: 'green', NOT_RECEIVED: 'red', RECALLED: 'purple', CANCELLED: 'gray' };
const TASK_TONE: Record<string, string> = { NOT_STARTED: 'gray', IN_PROGRESS: 'blue', SUBMITTED: 'amber', SIGNED_OFF: 'green' };

/** An asset's single Status (lifecycle status or transfer state; see src/lib/asset-status.ts). */
export const AssetStatus = ({ s }: { s: string }) => <Badge tone={ASSET_STATUS_TONE[s]}>{label(ASSET_STATUS_LABEL, s)}</Badge>;
export const TransferStatus = ({ s }: { s: string }) => <Badge tone={TRF_TONE[s]}>{label(TRANSFER_STATUS_LABEL, s)}</Badge>;
const RECEIPT_TONE: Record<string, string> = { GOOD: 'green', DAMAGED: 'red', PARTIALLY_DAMAGED: 'amber', NOT_RECEIVED: 'red' };
export const ReceiptCondition = ({ c }: { c: string }) => <Badge tone={RECEIPT_TONE[c]}>{label(RECEIPT_CONDITION_LABEL, c)}</Badge>;
export const LineStatus = ({ s }: { s: string }) => <Badge tone={LINE_TONE[s]}>{label(LINE_STATUS_LABEL, s)}</Badge>;
export const TaskStatus = ({ s }: { s: string }) => <Badge tone={TASK_TONE[s]}>{label(VER_TASK_LABEL, s)}</Badge>;
export const Flags = ({ flags }: { flags: string[] }) => <span className="flex flex-wrap gap-1">{flags.map((f) => <Badge key={f} tone={f === 'Missing' ? 'red' : f === 'Transfer exception' ? 'red' : 'amber'}>{f}</Badge>)}</span>;
export function DaysBadge({ days }: { days: number }) {
  const tone = days < 0 ? 'red' : days <= 30 ? 'amber' : days <= 90 ? 'blue' : 'gray';
  return <Badge tone={tone}>{days < 0 ? `Expired ${-days}d ago` : days === 0 ? 'Today' : `${days} days`}</Badge>;
}
