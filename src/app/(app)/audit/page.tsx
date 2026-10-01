'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { download, useApi } from '@/components/api';
import { DataTable, FilterSelect, SearchBox, useListState } from '@/components/list';
import { ErrorBox, Modal, PageHeader, useToast } from '@/components/ui';

interface Row { id: string; at: string; actorEmail: string | null; actorRole: string | null; action: string; entityType: string | null; entityId: string | null; entityLabel: string | null; before: unknown; after: unknown; details: unknown; ip: string | null }

const link = (r: Row) => !r.entityId ? null : ({ Asset: `/assets/${r.entityId}`, Transfer: `/transfers/${r.entityId}`, Renewable: `/renewals/${r.entityId}`, Employee: `/employees/${r.entityId}`, VerificationTask: `/verification/tasks/${r.entityId}`, Import: `/imports/${r.entityId}`, ApprovalRequest: `/approvals/${r.entityId}`, IntegrationSource: `/integrations/sources/${r.entityId}`, IntegrationRun: `/integrations/runs/${r.entityId}` } as Record<string, string>)[r.entityType ?? ''] ?? null;

function Inner() {
  const toast = useToast();
  const ls = useListState();
  const { data: meta } = useApi<{ actions: string[]; entityTypes: string[] }>('/api/audit/meta');
  const { data, error, loading } = useApi<{ rows: Row[]; total: number }>(`/api/audit?${ls.apiQuery}`);
  const [detail, setDetail] = useState<Row | null>(null);
  const exp = (fmt: string) => download(`/api/audit?${ls.apiQuery}&format=${fmt}`).catch((e) => toast(e.message, 'err'));
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" subtitle="Every change, sign-in and export, append-only. Times are IST."
        actions={<><button className="btn" onClick={() => exp('xlsx')}>Export Excel</button><button className="btn" onClick={() => exp('csv')}>CSV</button></>} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={ls.get('entityLabel')} onChange={(v) => ls.set('entityLabel', v)} placeholder="Record (Asset ID, transfer no.…)" />
        <SearchBox value={ls.get('actor')} onChange={(v) => ls.set('actor', v)} placeholder="Actor email" />
        <FilterSelect label="Action" value={ls.get('action')} onChange={(v) => ls.set('action', v)} options={(meta?.actions ?? []).map((a) => ({ value: a, label: a.replace(/_/g, ' ').toLowerCase() }))} />
        <FilterSelect label="Entity" value={ls.get('entityType')} onChange={(v) => ls.set('entityType', v)} options={(meta?.entityTypes ?? []).filter(Boolean).map((a) => ({ value: a, label: a }))} />
        <label className="flex items-center gap-1 text-sm">From <input type="date" className="input w-auto" value={ls.get('dateFrom')} onChange={(e) => ls.set('dateFrom', e.target.value)} /></label>
        <label className="flex items-center gap-1 text-sm">To <input type="date" className="input w-auto" value={ls.get('dateTo')} onChange={(e) => ls.set('dateTo', e.target.value)} /></label>
        {ls.query && <button className="btn btn-sm btn-ghost" onClick={ls.clear}>Clear</button>}
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))}
        columns={[
          { key: 'at', header: 'When', className: 'whitespace-nowrap', render: (r) => fmtDateTime(r.at) },
          { key: 'actor', header: 'Actor', render: (r) => <span className="text-xs">{r.actorEmail ?? 'system'}{r.actorRole && <div className="text-slate-500">{r.actorRole.toLowerCase().replace('_', ' ')}</div>}</span> },
          { key: 'action', header: 'Action', render: (r) => r.action.replace(/_/g, ' ').toLowerCase() },
          { key: 'record', header: 'Record', render: (r) => { const l = link(r); const t = r.entityLabel ?? r.entityType ?? ''; return l ? <Link href={l}>{t}</Link> : t; } },
          { key: 'details', header: '', render: (r) => (r.before || r.after || r.details) ? <button className="btn btn-sm btn-ghost" onClick={() => setDetail(r)}>Details</button> : null },
        ]} />
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? detail.action.replace(/_/g, ' ').toLowerCase() : ''} wide>
        {detail && <div className="space-y-2 text-xs">
          <div>{fmtDateTime(detail.at)} · {detail.actorEmail ?? 'system'}{detail.ip ? ` · ${detail.ip}` : ''}</div>
          {(['before', 'after', 'details'] as const).map((k) => detail[k] ? <div key={k}><div className="font-medium capitalize">{k}</div><pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(detail[k], null, 2)}</pre></div> : null)}
        </div>}
      </Modal>
    </div>
  );
}
export default function AuditPage() { return <Suspense><Inner /></Suspense>; }
