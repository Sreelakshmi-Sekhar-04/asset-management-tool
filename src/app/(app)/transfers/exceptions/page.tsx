'use client';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDateOnly } from '@/lib/format';
import { api, useApi } from '@/components/api';
import { DataTable, emptySelection, FilterSelect, useListState, type Selection } from '@/components/list';
import { useMe } from '@/components/me';
import { Badge, Field, FormModal, PageHeader, useToast } from '@/components/ui';

interface Ex { id: string; reason: string; status: string; resolution: string | null; resolutionNote: string | null; daysOpen: number; owner: string; createdAt: string; resendTransferId: string | null; assetId: string; line: { assetCode: string; serialNumber: string | null; make: string | null; model: string | null; transfer: { id: string; transferNo: string; fromLocation: { namePath: string }; toLocation: { namePath: string } } } }

export default function Exceptions() {
  const me = useMe();
  const toast = useToast();
  const ls = useListState({ status: 'OPEN' });
  const { data, loading, reload } = useApi<{ rows: Ex[]; total: number }>(`/api/transfers/exceptions?${ls.apiQuery}`);
  const [sel, setSel] = useState<Selection>(emptySelection());
  const [res, setRes] = useState<'' | 'RESENT' | 'LOCATED_AT_SENDER' | 'WRITTEN_OFF'>('');
  const [note, setNote] = useState('');
  const ids = sel.mode === 'ids' ? [...sel.ids] : [];
  return (
    <div>
      <PageHeader title="Transfer exceptions" subtitle="Lines marked not received. IT owns resolution: re-send, confirm located at sender, or write off (retire as lost)." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterSelect label="Status" value={ls.get('status')} onChange={(v) => ls.set('status', v || 'ALL')} options={[{ value: 'OPEN', label: 'Open' }, { value: 'RESOLVED', label: 'Resolved' }]} />
        {me.isIT && ids.length > 0 && <>
          <button className="btn btn-sm btn-primary" onClick={() => { setRes('RESENT'); setNote(''); }}>Re-send ({ids.length})</button>
          <button className="btn btn-sm" onClick={() => { setRes('LOCATED_AT_SENDER'); setNote(''); }}>Located at sender</button>
          <button className="btn btn-sm btn-danger" onClick={() => { setRes('WRITTEN_OFF'); setNote(''); }}>Write off</button>
        </>}
      </div>
      <DataTable rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)}
        selection={me.isIT ? sel : undefined} onSelection={setSel}
        columns={[
          { key: 'transfer', header: 'Transfer', render: (r) => <Link href={`/transfers/${r.line.transfer.id}`}>{r.line.transfer.transferNo}</Link> },
          { key: 'asset', header: 'Asset', render: (r) => <span><Link href={`/assets/${r.assetId}`}>{r.line.assetCode}</Link><span className="block text-xs text-slate-500">{r.line.make} {r.line.model} · {r.line.serialNumber ?? 'no serial'}</span></span> },
          { key: 'route', header: 'From → to', render: (r) => <span className="text-xs">{r.line.transfer.fromLocation.namePath}<br />→ {r.line.transfer.toLocation.namePath}</span> },
          { key: 'reason', header: 'Reason', render: (r) => r.reason },
          { key: 'status', header: 'Status', render: (r) => r.status === 'OPEN' ? <Badge tone="red">Open · {r.owner}</Badge> : <span className="text-xs"><Badge tone="green">{r.resolution?.replace(/_/g, ' ').toLowerCase()}</Badge>{r.resendTransferId && <Link className="ml-1" href={`/transfers/${r.resendTransferId}`}>re-send</Link>}{r.resolutionNote && <span className="block text-slate-500">{r.resolutionNote}</span>}</span> },
          { key: 'age', header: 'Age', render: (r) => <span className="text-xs">{fmtDateOnly(r.createdAt)}<br />{r.daysOpen} day(s)</span> },
        ]} />
      <FormModal open={!!res} onClose={() => setRes('')} danger={res === 'WRITTEN_OFF'} submitLabel="Resolve"
        title={res === 'RESENT' ? 'Re-send on a new transfer' : res === 'LOCATED_AT_SENDER' ? 'Confirm located at sender' : 'Write off as lost'}
        onSubmit={async () => {
          const r = await api<{ transfer?: { transferNo: string }; pendingApproval?: { requestNo: string } }>('/api/transfers/exceptions/resolve', { body: { exceptionIds: ids, resolution: res, note: note || undefined } });
          toast(r.pendingApproval ? `Write-off sent for approval: ${r.pendingApproval.requestNo}` : r.transfer ? `Re-sent as ${r.transfer.transferNo}` : 'Resolved');
          setSel(emptySelection()); reload();
        }}>
        <p className="text-sm text-slate-600">{res === 'RESENT' ? 'A new transfer is raised for the same route with these assets, linked to the exceptions.' : res === 'LOCATED_AT_SENDER' ? 'The assets stay at the sender; the flag is cleared.' : 'The assets are checked in and retired as Lost. This follows the retirement approval rule.'}</p>
        <Field label="Note"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </FormModal>
    </div>
  );
}
