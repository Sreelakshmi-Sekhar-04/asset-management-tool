'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { download, useApi } from '@/components/api';
import { DataTable, useListState } from '@/components/list';
import { useColumnFilters } from '@/components/list-filters';
import { ErrorBox, Modal, PageHeader, useToast } from '@/components/ui';

interface Row { id: string; at: string; actorEmail: string | null; actorRole: string | null; action: string; entityType: string | null; entityId: string | null; entityLabel: string | null; before: unknown; after: unknown; details: unknown; ip: string | null }

const link = (r: Row) => !r.entityId ? null : ({ Asset: `/assets/${r.entityId}`, Renewable: `/renewals/${r.entityId}`, Employee: `/employees/${r.entityId}`, VerificationTask: `/campaigns/tasks/${r.entityId}`, Import: `/imports/${r.entityId}`, ApprovalRequest: `/approvals/${r.entityId}`, IntegrationSource: `/integrations/sources/${r.entityId}`, IntegrationRun: `/integrations/runs/${r.entityId}` } as Record<string, string>)[r.entityType ?? ''] ?? null;

function Inner() {
  const toast = useToast();
  const ls = useListState();
  const { data: meta } = useApi<{ actions: string[]; entityTypes: string[] }>('/api/audit/meta');
  const { data, error, loading } = useApi<{ rows: Row[]; total: number }>(`/api/audit?${ls.apiQuery}`);
  const [detail, setDetail] = useState<Row | null>(null);
  const f = useColumnFilters(ls);
  const filters = {
    at: f.dates('dateFrom', 'dateTo', 'When'),
    actor: f.text('actor', 'Actor', 'Actor email contains…'),
    action: f.option('action', 'Action', (meta?.actions ?? []).map((a) => ({ value: a, label: a.replace(/_/g, ' ').toLowerCase() })), 'All actions'),
    record: f.both(f.text('entityLabel', 'Record', 'Asset ID, transfer no.… contains'), f.option('entityType', 'Record type', (meta?.entityTypes ?? []).filter(Boolean).map((a) => ({ value: a, label: a })), 'Any type')),
  };
  const exp = (fmt: string) => download(`/api/audit?${ls.apiQuery}&format=${fmt}`).catch((e) => toast(e.message, 'err'));
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" subtitle="Every change, sign-in and export, append-only. Times are IST."
        actions={<><button className="btn" onClick={() => exp('xlsx')}>Export Excel</button><button className="btn" onClick={() => exp('csv')}>CSV</button></>} />
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))}
        toolbar={f.strip()}
        columns={[
          { key: 'at', filter: filters.at, header: 'When', className: 'whitespace-nowrap', render: (r) => fmtDateTime(r.at) },
          { key: 'actor', filter: filters.actor, header: 'Actor', render: (r) => <span className="text-xs">{r.actorEmail ?? 'system'}{r.actorRole && <div className="text-slate-500">{r.actorRole.toLowerCase().replace('_', ' ')}</div>}</span> },
          { key: 'action', filter: filters.action, header: 'Action', render: (r) => r.action.replace(/_/g, ' ').toLowerCase() },
          { key: 'record', filter: filters.record, header: 'Record', render: (r) => { const l = link(r); const t = r.entityLabel ?? r.entityType ?? ''; return l ? <Link href={l}>{t}</Link> : t; } },
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
