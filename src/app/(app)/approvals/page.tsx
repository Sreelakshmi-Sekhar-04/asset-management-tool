'use client';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { APPROVAL_ACTION_LABEL, label } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import type { ApprovalReq } from '@/components/approval-chain';
import { DataTable, emptySelection, FilterSelect, useListState, type Selection } from '@/components/list';
import { useMe } from '@/components/me';
import { Badge, Field, FormModal, PageHeader, Tabs, useToast } from '@/components/ui';

type Row = ApprovalReq & { canAct: boolean; canCancel: boolean; entityType: string | null; entityId: string | null };
const TONE: Record<string, string> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray', FAILED: 'red' };

export default function Approvals() {
  const me = useMe();
  const toast = useToast();
  const ls = useListState({ view: me.isBranch ? 'mine' : 'actionable' });
  const view = ls.get('view');
  const q = new URLSearchParams(ls.apiQuery);
  q.delete('view');
  if (view === 'actionable') q.set('actionable', 'true');
  if (view === 'mine') q.set('mine', 'true');
  const { data, loading, reload } = useApi<{ rows: Row[]; total: number }>(`/api/approvals?${q}`);
  const [sel, setSel] = useState<Selection>(emptySelection());
  const [bulk, setBulk] = useState<'' | 'APPROVE' | 'REJECT'>('');
  const [comment, setComment] = useState('');
  const ids = sel.mode === 'ids' ? [...sel.ids] : [];
  return (
    <div>
      <PageHeader title="Approvals" subtitle="You cannot approve your own request (Administrators excepted). Parallel steps all need a decision; sequential steps run in order." />
      <Tabs value={view} onChange={(v) => { ls.setMany({ view: v }); setSel(emptySelection()); }} tabs={[...(me.isIT ? [{ key: 'actionable', label: 'Awaiting my decision' }] : []), { key: 'mine', label: 'My requests' }, { key: 'all', label: 'All visible' }]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {view !== 'actionable' && <FilterSelect label="Status" value={ls.get('status')} onChange={(v) => ls.set('status', v)} options={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED'].map((s) => ({ value: s, label: s.toLowerCase() }))} />}
        <FilterSelect label="Action" value={ls.get('action')} onChange={(v) => ls.set('action', v)} options={Object.entries(APPROVAL_ACTION_LABEL).map(([value, l]) => ({ value, label: l }))} />
        {view === 'actionable' && ids.length > 0 && <>
          <button className="btn btn-sm btn-primary" onClick={() => { setBulk('APPROVE'); setComment(''); }}>Approve {ids.length}</button>
          <button className="btn btn-sm btn-danger" onClick={() => { setBulk('REJECT'); setComment(''); }}>Reject {ids.length}</button>
        </>}
      </div>
      <DataTable rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)}
        selection={view === 'actionable' ? sel : undefined} onSelection={setSel} empty={view === 'actionable' ? 'Nothing is waiting for you.' : 'No requests.'}
        columns={[
          { key: 'requestNo', header: 'Request', render: (r) => <Link href={r.entityType === 'Transfer' && r.entityId ? `/transfers/${r.entityId}` : `/approvals/${r.id}`} className="font-medium">{r.requestNo}</Link> },
          { key: 'action', header: 'Action', render: (r) => label(APPROVAL_ACTION_LABEL, r.action) },
          { key: 'summary', header: 'Summary', render: (r) => <span className="text-xs">{r.summary}</span> },
          { key: 'policy', header: 'Rule', render: (r) => <span className="text-xs text-slate-500">{r.policyName}</span> },
          { key: 'by', header: 'Raised by', render: (r) => <span className="text-xs">{r.initiatorName}<br />{fmtDateTime(r.createdAt)}</span> },
          { key: 'status', header: 'Status', render: (r) => <span className="flex flex-col items-start gap-1"><Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>{r.status === 'PENDING' && <span className="text-xs text-slate-500">Step {r.currentOrder}</span>}</span> },
        ]} />
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
