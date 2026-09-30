'use client';
import { fmtDateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/labels';
import { Badge } from './ui';

export interface ApprovalTask { id: string; stepOrder: number; approverType: string; approverUserId: string | null; approverRole: string | null; status: string; decidedByName: string | null; decidedAt: string | null; comment: string | null; approverName?: string | null }
export interface ApprovalReq { id: string; requestNo: string; action: string; status: string; policyName: string; summary: string; initiatorName: string; createdAt: string; currentOrder: number; decidedAt: string | null; failureReason: string | null; tasks: ApprovalTask[] }

const TONE: Record<string, string> = { WAITING: 'gray', PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', SKIPPED: 'gray', CANCELLED: 'gray' };

export function ApprovalChain({ req }: { req: ApprovalReq }) {
  const orders = [...new Set(req.tasks.map((t) => t.stepOrder))].sort((a, b) => a - b);
  return (
    <ol className="space-y-2 text-sm">
      {orders.map((o) => (
        <li key={o} className="rounded border border-slate-200 p-2">
          <div className="mb-1 text-xs font-medium text-slate-500">Step {o}{req.tasks.filter((t) => t.stepOrder === o).length > 1 ? ' (all in parallel)' : ''}{o === req.currentOrder && req.status === 'PENDING' ? ' · current' : ''}</div>
          {req.tasks.filter((t) => t.stepOrder === o).map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{t.approverType === 'ROLE' ? `Any ${ROLE_LABEL[t.approverRole ?? ''] ?? t.approverRole}` : t.approverType === 'HOLDER_MANAGER' ? "Holder's manager" : t.approverName ?? 'Named approver'}</span>
              <span className="flex items-center gap-2">
                <Badge tone={TONE[t.status]}>{t.status.toLowerCase()}</Badge>
                {t.decidedByName && <span className="text-xs text-slate-500">{t.decidedByName} · {fmtDateTime(t.decidedAt)}</span>}
              </span>
              {t.comment && <div className="w-full text-xs text-slate-600">“{t.comment}”</div>}
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}
