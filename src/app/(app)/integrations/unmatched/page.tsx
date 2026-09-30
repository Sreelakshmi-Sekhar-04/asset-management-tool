'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { CategorySelect, LocationSelect } from '@/components/pickers';
import { Badge, ErrorBox, Field, FormModal, PageHeader, useToast } from '@/components/ui';

interface U { id: string; externalId: string | null; serialNumber: string | null; hostname: string | null; payload: Record<string, unknown>; status: string; lastSeenAt: string; assetId: string | null; source: { name: string } }

function Inner() {
  const toast = useToast();
  const ls = useListState({ status: 'OPEN' });
  const { data: sources } = useApi<{ id: string; name: string }[]>('/api/integrations/sources');
  const { data, error, loading, reload } = useApi<{ rows: U[]; total: number }>(`/api/integrations/unmatched${qs({ status: ls.get('status'), sourceId: ls.get('sourceId'), page: ls.page, pageSize: ls.pageSize })}`);
  const [dlg, setDlg] = useState<{ u: U; action: 'LINK' | 'CREATE' | 'DISMISS' } | null>(null);
  const [v, setV] = useState({ assetCode: '', categoryId: '', locationId: '', make: '', model: '', reason: '' });
  const openDlg = (u: U, action: 'LINK' | 'CREATE' | 'DISMISS') => { setV({ assetCode: '', categoryId: '', locationId: '', make: String(u.payload.make ?? ''), model: String(u.payload.model ?? ''), reason: '' }); setDlg({ u, action }); };
  const open = ls.get('status') === 'OPEN';
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/integrations', label: 'Integrations' }} title="Unmatched device records" subtitle="Records a source sent that match no asset by serial number (or the configured secondary key)." />
      <div className="flex gap-2">
        <FilterSelect label="Status" value={ls.get('status')} onChange={(x) => ls.set('status', x || 'OPEN')} options={[{ value: 'OPEN', label: 'Open' }, { value: 'LINKED', label: 'Linked' }, { value: 'CREATED', label: 'Created' }, { value: 'DISMISSED', label: 'Dismissed' }]} />
        <FilterSelect label="Source" value={ls.get('sourceId')} onChange={(x) => ls.set('sourceId', x)} options={(sources ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="Nothing unmatched."
        columns={[
          { key: 'serial', header: 'Serial', render: (u) => u.serialNumber ?? '—' },
          { key: 'hostname', header: 'Hostname', render: (u) => u.hostname ?? '—' },
          { key: 'device', header: 'Device', render: (u) => <span className="text-xs">{[u.payload.make, u.payload.model, u.payload.os].filter(Boolean).join(' · ')}{u.payload.currentUser ? <div className="text-slate-500">User: {String(u.payload.currentUser)}</div> : null}</span> },
          { key: 'source', header: 'Source', render: (u) => u.source.name },
          { key: 'lastSeenAt', header: 'Last seen', className: 'whitespace-nowrap', render: (u) => fmtDateTime(u.lastSeenAt) },
          { key: 'actions', header: '', render: (u) => open ? (
            <span className="flex gap-1"><button className="btn btn-sm btn-primary" onClick={() => openDlg(u, 'LINK')}>Link</button><button className="btn btn-sm" onClick={() => openDlg(u, 'CREATE')}>Create asset</button><button className="btn btn-sm btn-ghost" onClick={() => openDlg(u, 'DISMISS')}>Dismiss</button></span>
          ) : u.assetId ? <Link href={`/assets/${u.assetId}`}>View asset</Link> : <Badge>{u.status.toLowerCase()}</Badge> },
        ]} />
      <FormModal open={!!dlg} onClose={() => setDlg(null)} title={dlg?.action === 'LINK' ? 'Link to an existing asset' : dlg?.action === 'CREATE' ? 'Create an asset from this record' : 'Dismiss record'}
        submitLabel={dlg?.action === 'LINK' ? 'Link' : dlg?.action === 'CREATE' ? 'Create' : 'Dismiss'}
        onSubmit={async () => {
          const d = dlg!;
          let body: Record<string, unknown>;
          if (d.action === 'LINK') { const a = await api<{ id: string }>(`/api/assets/lookup?q=${encodeURIComponent(v.assetCode.trim())}`); body = { action: 'LINK', assetId: a.id }; }
          else if (d.action === 'CREATE') body = { action: 'CREATE', categoryId: v.categoryId, locationId: v.locationId, make: v.make, model: v.model };
          else body = { action: 'DISMISS', reason: v.reason };
          await api(`/api/integrations/unmatched/${d.u.id}/resolve`, { body });
          toast('Done'); reload();
        }}>
        {dlg?.action === 'LINK' && <Field label="Asset ID, serial or legacy tag" required><input className="input" value={v.assetCode} onChange={(e) => setV({ ...v, assetCode: e.target.value })} required /></Field>}
        {dlg?.action === 'CREATE' && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category" required><CategorySelect value={v.categoryId} onChange={(categoryId) => setV({ ...v, categoryId })} required /></Field>
          <Field label="Location" required><LocationSelect value={v.locationId} onChange={(locationId) => setV({ ...v, locationId })} /></Field>
          <Field label="Make" required><input className="input" value={v.make} onChange={(e) => setV({ ...v, make: e.target.value })} required /></Field>
          <Field label="Model" required><input className="input" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} required /></Field>
        </div>}
        {dlg?.action === 'DISMISS' && <Field label="Reason" required><input className="input" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required /></Field>}
      </FormModal>
    </div>
  );
}
export default function UnmatchedPage() { return <Suspense><Inner /></Suspense>; }
