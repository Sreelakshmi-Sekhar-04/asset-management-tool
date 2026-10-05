'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { FIELD_LABEL } from '@/components/integration-bits';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { ErrorBox, PageHeader, useToast } from '@/components/ui';

interface C { id: string; entityType: string; entityId: string; entityLabel: string; field: string; currentValue: string | null; incomingValue: string | null; status: string; createdAt: string; resolvedAt: string | null; source: { name: string } }

function Inner() {
  const toast = useToast();
  const ls = useListState({ status: 'OPEN' });
  const { data: sources } = useApi<{ id: string; name: string }[]>('/api/integrations/sources');
  const { data, error, loading, reload } = useApi<{ rows: C[]; total: number }>(`/api/integrations/conflicts${qs({ status: ls.get('status'), sourceId: ls.get('sourceId'), page: ls.page, pageSize: ls.pageSize })}`);
  const decide = async (c: C, decision: 'ACCEPT_INCOMING' | 'KEEP_CURRENT') => {
    try { await api(`/api/integrations/conflicts/${c.id}/resolve`, { body: { decision } }); toast(decision === 'ACCEPT_INCOMING' ? 'Incoming value applied' : 'Current value kept'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const open = ls.get('status') === 'OPEN';
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/integrations', label: 'Integrations' }} title="Integration conflicts" subtitle="A source sent a value that differs from one entered or owned elsewhere. Choose which value to keep." />
      <div className="flex gap-2">
        <FilterSelect label="Status" value={ls.get('status')} onChange={(v) => ls.set('status', v || 'OPEN')} options={[{ value: 'OPEN', label: 'Open' }, { value: 'ACCEPTED_INCOMING', label: 'Accepted incoming' }, { value: 'KEPT_CURRENT', label: 'Kept current' }]} />
        <FilterSelect label="Source" value={ls.get('sourceId')} onChange={(v) => ls.set('sourceId', v)} options={(sources ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="No conflicts."
        columns={[
          { key: 'record', header: 'Record', render: (c) => <Link href={c.entityType === 'ASSET' ? `/assets/${c.entityId}` : `/employees/${c.entityId}`}>{c.entityLabel}</Link> },
          { key: 'field', header: 'Field', render: (c) => FIELD_LABEL[c.field] ?? c.field },
          { key: 'current', header: 'Current value', render: (c) => <span className="break-all">{c.currentValue ?? '—'}</span> },
          { key: 'incoming', header: 'Incoming value', render: (c) => <span className="break-all font-medium">{c.incomingValue ?? '—'}</span> },
          { key: 'source', header: 'Source', render: (c) => c.source.name },
          { key: 'createdAt', header: 'Raised', className: 'whitespace-nowrap', render: (c) => fmtDateTime(c.createdAt) },
          { key: 'actions', header: '', render: (c) => open ? <span className="flex gap-1"><button className="btn btn-sm btn-primary" onClick={() => decide(c, 'ACCEPT_INCOMING')}>Use incoming</button><button className="btn btn-sm" onClick={() => decide(c, 'KEEP_CURRENT')}>Keep current</button></span> : <span className="text-xs">{fmtDateTime(c.resolvedAt)}</span> },
        ]} />
    </div>
  );
}
export default function ConflictsPage() { return <Suspense><Inner /></Suspense>; }
