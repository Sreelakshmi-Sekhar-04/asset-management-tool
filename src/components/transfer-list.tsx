'use client';
import Link from 'next/link';
import { fmtDateOnly } from '@/lib/format';
import { TransferStatus } from './badges';
import type { Column } from './list';
import { Badge } from './ui';

export interface TransferRow {
  id: string; transferNo: string; from: string; to: string; reason: string; status: string; requestedBy: string; requestedAt: string; effectiveDate: string; approvedAt: string | null; approver: string | null;
  completedAt: string | null; interState: boolean; recordedLate: boolean; counts: { total: number; received: number; rejected: number; recalled: number; pending: number; resolved: number }; daysInTransit: number | null; direction: 'inbound' | 'outbound' | null;
}

export const transferColumns = (agingDays?: number): Column<TransferRow>[] => [
  { key: 'transferNo', header: 'Transfer', sortable: true, render: (r) => <span className="whitespace-nowrap"><Link href={`/transfers/${r.id}`} className="font-medium">{r.transferNo}</Link>{r.direction && <span className="ml-1 text-xs text-slate-500">{r.direction === 'inbound' ? '↓ in' : '↑ out'}</span>}</span> },
  { key: 'route', header: 'From → to', render: (r) => <span className="text-xs">{r.from}<br />→ {r.to}</span> },
  { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-2 max-w-[16rem] text-xs">{r.reason}</span> },
  { key: 'status', header: 'Status', sortable: true, render: (r) => <span className="flex flex-col items-start gap-1"><TransferStatus s={r.status} />{r.interState && <Badge tone="purple">Inter-state</Badge>}{r.recordedLate && <Badge tone="amber">Recorded late</Badge>}</span> },
  { key: 'lines', header: 'Lines', render: (r) => <span className="whitespace-nowrap text-xs">{r.counts.resolved} of {r.counts.total} resolved{r.counts.rejected > 0 && <span className="block text-red-600">{r.counts.rejected} not received</span>}</span> },
  { key: 'requestedAt', header: 'Requested', sortable: true, render: (r) => <span className="whitespace-nowrap text-xs">{fmtDateOnly(r.requestedAt)}<br />{r.requestedBy}</span> },
  { key: 'approvedAt', header: 'Approved', sortable: true, render: (r) => <span className="text-xs">{r.approvedAt ? <>{fmtDateOnly(r.approvedAt)}<br />{r.approver ?? 'Auto'}</> : '—'}</span> },
  { key: 'days', header: 'In transit', render: (r) => (r.daysInTransit !== null ? <Badge tone={agingDays && r.daysInTransit >= agingDays ? 'red' : 'blue'}>{r.daysInTransit} d</Badge> : '—') },
];
