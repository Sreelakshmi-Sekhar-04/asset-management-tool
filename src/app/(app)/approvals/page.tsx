'use client';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { HISTORIC_ACTION_LABEL, label } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { pendingStage, type ApprovalReq } from '@/components/approval-chain';
import { DataTable, emptySelection, useListState, type Selection } from '@/components/list';
import { useColumnFilters } from '@/components/list-filters';
import { useMe } from '@/components/me';
import { TransferStatus } from '@/components/badges';
import { ReceiveDialog, type Shipment } from '@/components/transfer-receipt';
import { Badge, Field, FormModal, PageHeader, Tabs, useToast } from '@/components/ui';

type Row = ApprovalReq & { canAct: boolean; canCancel: boolean; entityType: string | null; entityId: string | null };
const TONE: Record<string, string> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray', FAILED: 'red' };

export default function Approvals() {
  const me = useMe();
  const toast = useToast();
  const ls = useListState({ view: 'actionable' });
  const view = ls.get('view');
  const q = new URLSearchParams(ls.apiQuery);
  q.delete('view');
  if (view === 'actionable') q.set('actionable', 'true');
  if (view === 'mine') q.set('mine', 'true');
  const { data, loading, reload } = useApi<{ rows: Row[]; total: number }>(view === 'receive' ? null : `/api/approvals?${q}`);
  const [sel, setSel] = useState<Selection>(emptySelection());
  const [bulk, setBulk] = useState<'' | 'APPROVE' | 'REJECT'>('');
  const [comment, setComment] = useState('');
  const ids = sel.mode === 'ids' ? [...sel.ids] : [];
  const f = useColumnFilters(ls);
  const actionFilter = f.option('action', 'Action', Object.entries(HISTORIC_ACTION_LABEL).map(([value, l]) => ({ value, label: l })), 'All actions');
  const statusFilter = view !== 'actionable' ? f.option('status', 'Status', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED'].map((s) => ({ value: s, label: s[0] + s.slice(1).toLowerCase() })), 'All statuses') : undefined;
  return (
    <div>
      <PageHeader title="Approvals" subtitle="You cannot approve your own request (Administrators excepted). Parallel steps all need a decision; sequential steps run in order." />
      <Tabs value={view} onChange={(v) => { ls.setMany({ view: v }); setSel(emptySelection()); }} tabs={[{ key: 'actionable', label: 'Awaiting my decision' }, { key: 'receive', label: 'To receive' }, { key: 'mine', label: 'My requests' }, { key: 'all', label: 'All visible' }]} />
      {view === 'receive' && <ToReceive />}
      {view === 'actionable' && ids.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-sm btn-primary" onClick={() => { setBulk('APPROVE'); setComment(''); }}>Approve {ids.length}</button>
          <button className="btn btn-sm btn-danger" onClick={() => { setBulk('REJECT'); setComment(''); }}>Reject {ids.length}</button>
        </div>
      )}
      {view !== 'receive' && <DataTable rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))}
        selection={view === 'actionable' && me.isIT ? sel : undefined} onSelection={setSel} empty={view === 'actionable' ? 'Nothing is waiting for you.' : 'No requests.'}
        toolbar={f.strip()}
        columns={[
          { key: 'requestNo', header: 'Request', render: (r) => <Link href={`/approvals/${r.id}`} className="font-medium">{r.requestNo}</Link> },
          { key: 'action', header: 'Action', filter: actionFilter, render: (r) => label(HISTORIC_ACTION_LABEL, r.action) },
          { key: 'summary', header: 'Summary', render: (r) => <span className="text-xs">{r.summary}</span> },
          { key: 'policy', header: 'Rule', render: (r) => <span className="text-xs text-slate-500">{r.policyName}</span> },
          { key: 'by', header: 'Raised by', render: (r) => <span className="text-xs">{r.initiatorName}<br />{fmtDateTime(r.createdAt)}</span> },
          { key: 'status', header: 'Status', filter: statusFilter, render: (r) => <span className="flex flex-col items-start gap-1"><Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>{r.status === 'PENDING' && <span className="text-xs text-slate-500">{pendingStage(r)}</span>}</span> },
        ]} />}
      <FormModal open={!!bulk} onClose={() => setBulk('')} title={`${bulk === 'APPROVE' ? 'Approve' : 'Reject'} ${ids.length} request(s)`} submitLabel={bulk === 'APPROVE' ? 'Approve' : 'Reject'} danger={bulk === 'REJECT'}
        onSubmit={async () => {
          const r = await api<{ succeeded: number; failed: number; results: { ok: boolean; error?: string }[] }>('/api/approvals/bulk-decide', { body: { requestIds: ids, decision: bulk, comment: comment || undefined } });
          toast(`${r.succeeded} decided${r.failed ? `; ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error}` : ''}`, r.failed ? 'err' : 'ok');
          setSel(emptySelection()); reload();
        }}>
        <Field label={bulk === 'REJECT' ? 'Reason (required)' : 'Comment'} required={bulk === 'REJECT'}><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} required={bulk === 'REJECT'} /></Field>
      </FormModal>
    </div>
  );
}

/** Approved transfers waiting for me to confirm what arrived (destination managers and Administrators). */
function ToReceive() {
  const { data, loading, reload } = useApi<Shipment[]>('/api/transfers/to-receive');
  const [receiving, setReceiving] = useState<Shipment | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const short = (p: string) => p.split(' / ').pop();
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">Transfers with both approvals. Nothing moves until the destination confirms what actually arrived and its condition.</p>
      <DataTable rows={(data ?? []).slice((page - 1) * pageSize, page * pageSize)} total={data?.length ?? 0} loading={loading} page={page} pageSize={pageSize} onPage={setPage} empty="Nothing is waiting for you to receive."
        columns={[
          { key: 'transferNo', header: 'Transfer', render: (s) => <Link href={`/approvals/${s.approvalRequestId}`} className="font-medium">{s.transferNo}</Link> },
          { key: 'assets', header: 'Assets', render: (s) => <span className="text-xs">{s.lines.filter((l) => l.open).map((l) => `${l.assetCode} ${l.name}`).join(', ')}</span> },
          { key: 'from', header: 'From', render: (s) => short(s.from) },
          { key: 'to', header: 'To', render: (s) => short(s.to) },
          { key: 'approved', header: 'Approved', render: (s) => <span className="text-xs">{s.approverNames}<br />{fmtDateTime(s.approvedAt)}</span> },
          { key: 'status', header: 'Status', render: (s) => <TransferStatus s={s.status} /> },
          { key: 'act', header: '', render: (s) => s.canReceive && <button className="btn btn-sm btn-primary" onClick={() => setReceiving(s)}>Confirm receipt</button> },
        ]} />
      {receiving && <ReceiveDialog shipment={receiving} onClose={() => setReceiving(null)} onDone={reload} />}
    </>
  );
}
