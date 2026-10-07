import { ASSET_TRANSFER_STATUS_LABEL, label, LINE_STATUS_LABEL, STATUS_LABEL, TRANSFER_STATUS_LABEL, VER_TASK_LABEL } from '@/lib/labels';
import { Badge } from './ui';

const ASSET_TONE: Record<string, string> = { IN_STOCK: 'blue', ASSIGNED: 'green', UNDER_REPAIR: 'amber', RETIRED: 'gray' };
const TRF_TONE: Record<string, string> = { DRAFT: 'gray', PENDING_APPROVAL: 'amber', IN_TRANSIT: 'blue', PARTIALLY_RECEIVED: 'purple', COMPLETED: 'green', REJECTED: 'red', CANCELLED: 'gray' };
const LINE_TONE: Record<string, string> = { DRAFT: 'gray', PENDING_APPROVAL: 'amber', IN_TRANSIT: 'blue', RECEIVED: 'green', NOT_RECEIVED: 'red', RECALLED: 'purple', CANCELLED: 'gray' };
const TASK_TONE: Record<string, string> = { NOT_STARTED: 'gray', IN_PROGRESS: 'blue', SUBMITTED: 'amber', SIGNED_OFF: 'green' };

export const AssetStatus = ({ s }: { s: string }) => <Badge tone={ASSET_TONE[s]}>{label(STATUS_LABEL, s)}</Badge>;
export const TransferStatus = ({ s }: { s: string }) => <Badge tone={TRF_TONE[s]}>{label(TRANSFER_STATUS_LABEL, s)}</Badge>;
const ASSET_TRF_TONE: Record<string, string> = { NONE: 'gray', PENDING_ADMIN: 'amber', PENDING_LOCATION_MANAGER: 'amber', APPROVED: 'green', REJECTED: 'red' };
/** Where an asset's latest transfer request stands (asset register, asset page). */
export const AssetTransferStatus = ({ s, title }: { s: string; title?: string }) => <Badge tone={ASSET_TRF_TONE[s]} title={title}>{label(ASSET_TRANSFER_STATUS_LABEL, s)}</Badge>;
export const LineStatus = ({ s }: { s: string }) => <Badge tone={LINE_TONE[s]}>{label(LINE_STATUS_LABEL, s)}</Badge>;
export const TaskStatus = ({ s }: { s: string }) => <Badge tone={TASK_TONE[s]}>{label(VER_TASK_LABEL, s)}</Badge>;
export const Flags = ({ flags }: { flags: string[] }) => <span className="flex flex-wrap gap-1">{flags.map((f) => <Badge key={f} tone={f === 'Missing' ? 'red' : f === 'Transfer exception' ? 'red' : 'amber'}>{f}</Badge>)}</span>;
export function DaysBadge({ days }: { days: number }) {
  const tone = days < 0 ? 'red' : days <= 30 ? 'amber' : days <= 90 ? 'blue' : 'gray';
  return <Badge tone={tone}>{days < 0 ? `Expired ${-days}d ago` : days === 0 ? 'Today' : `${days} days`}</Badge>;
}
