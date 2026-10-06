'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { countsText, RunStatus, type RunCounts } from '@/components/integration-bits';
import { DataTable, useListState } from '@/components/list';
import { useColumnFilters } from '@/components/list-filters';
import { useMe } from '@/components/me';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, Stat, Tabs } from '@/components/ui';

interface Health { id: string; key: string; name: string; kind: string; active: boolean; pullEnabled: boolean; credential: string | null; lastRunAt: string | null; lastRunStatus: string | null; lastSuccessAt: string | null; lastRun: RunCounts | null; last30Days: RunCounts; unmatchedOpen: number; conflictsOpen: number; unacknowledgedErrors: { runId: string; at: string; status: string; errors: { message: string }[] }[] }
interface Run extends RunCounts { id: string; mode: string; status: string; batchId: string | null; startedAt: string; finishedAt: string | null; acknowledgedAt: string | null; source: { name: string; key: string } }

function Inner() {
  const me = useMe();
  const router = useRouter();
  const ls = useListState({ tab: 'health' });
  const tab = ls.get('tab');
  const health = useApi<Health[]>('/api/integrations/health');
  const runs = useApi<{ rows: Run[]; total: number }>(tab === 'runs' ? `/api/integrations/runs${qs({ sourceId: ls.get('sourceId'), status: ls.get('status'), page: ls.page, pageSize: ls.pageSize })}` : null);
  const [add, setAdd] = useState(false);
  const [n, setN] = useState({ key: '', name: '', kind: 'DEVICE' });
  const h = health.data ?? [];
  const f = useColumnFilters(ls);
  const tot = (k: 'unmatchedOpen' | 'conflictsOpen') => h.reduce((s, x) => s + x[k], 0);
  return (
    <div className="space-y-4">
      <PageHeader title="Integrations" subtitle="Device feeds (MDM, RMM, endpoint tools) and the Active Directory employee sync. External records never overwrite your data silently."
        actions={me.isAdmin && <button className="btn btn-primary" onClick={() => setAdd(true)}>Add source</button>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sources" value={h.length} />
        <Stat label="Failing sources" value={h.filter((x) => x.lastRunStatus === 'FAILED').length} tone={h.some((x) => x.lastRunStatus === 'FAILED') ? 'red' : undefined} />
        <Stat label="Open conflicts" value={tot('conflictsOpen')} href="/integrations/conflicts" tone={tot('conflictsOpen') ? 'amber' : undefined} />
        <Stat label="Unmatched records" value={tot('unmatchedOpen')} href="/integrations/unmatched" tone={tot('unmatchedOpen') ? 'amber' : undefined} />
      </div>
      <Tabs value={tab} onChange={(k) => ls.setMany({ tab: k })} tabs={[{ key: 'health', label: 'Sources and health' }, { key: 'runs', label: 'Run history' }]} />
      <ErrorBox error={health.error} />
      {tab === 'health' && (!health.data ? <div className="flex justify-center py-10"><Spinner /></div> : h.length === 0 ? <Card><p className="text-sm text-slate-500">No sources configured yet.</p></Card> : (
        <div className="space-y-3">
          {h.map((s) => (
            <Card key={s.id} title={<span className="flex flex-wrap items-center gap-2"><Link href={`/integrations/sources/${s.id}`}>{s.name}</Link><span className="text-xs font-normal text-slate-500">{s.key}</span>
              <Badge tone="blue">{s.kind === 'DEVICE' ? 'Device feed' : 'Directory (AD)'}</Badge>{!s.active && <Badge>Inactive</Badge>}<RunStatus s={s.lastRunStatus} /></span>}>
              <dl className="kv text-sm">
                <dt>Last run</dt><dd>{s.lastRunAt ? fmtDateTime(s.lastRunAt) : 'Never'} {s.lastRun && <span className="text-xs text-slate-500">· {countsText(s.lastRun)}</span>}</dd>
                <dt>Last success</dt><dd>{s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : 'Never'}</dd>
                <dt>Last 30 days</dt><dd className="text-xs">{countsText(s.last30Days)}</dd>
                {s.credential && <><dt>API key</dt><dd>{s.credential}</dd></>}
                <dt>Queues</dt><dd><Link href={`/integrations/conflicts?sourceId=${s.id}`}>{s.conflictsOpen} conflicts</Link> · <Link href={`/integrations/unmatched?sourceId=${s.id}`}>{s.unmatchedOpen} unmatched</Link></dd>
              </dl>
              {s.unacknowledgedErrors.length > 0 && (
                <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                  <b>{s.unacknowledgedErrors.length} run(s) with errors not yet acknowledged.</b>
                  <ul className="mt-1 list-disc pl-4">{s.unacknowledgedErrors.slice(0, 3).map((e) => <li key={e.runId}><Link href={`/integrations/runs/${e.runId}`}>{fmtDateTime(e.at)}</Link>: {e.errors[0]?.message ?? e.status.toLowerCase()}</li>)}</ul>
                </div>
              )}
            </Card>
          ))}
        </div>
      ))}
      {tab === 'runs' && (
        <>
          <DataTable loading={runs.loading} rows={runs.data?.rows ?? []} total={runs.data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))}
            toolbar={f.strip()}
            columns={[
              { key: 'startedAt', header: 'Started', className: 'whitespace-nowrap', render: (r) => <Link href={`/integrations/runs/${r.id}`}>{fmtDateTime(r.startedAt)}</Link> },
              { key: 'source', header: 'Source', filter: f.option('sourceId', 'Source', h.map((s) => ({ value: s.id, label: s.name })), 'All sources'), render: (r) => r.source.name },
              { key: 'mode', header: 'Mode', render: (r) => r.mode.toLowerCase() },
              { key: 'status', header: 'Status', filter: f.option('status', 'Status', ['SUCCESS', 'PARTIAL', 'FAILED', 'DUPLICATE', 'RUNNING'].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() })), 'All statuses'), render: (r) => <span className="flex gap-1"><RunStatus s={r.status} />{r.acknowledgedAt && <Badge>Acknowledged</Badge>}</span> },
              { key: 'counts', header: 'Counts', render: (r) => <span className="text-xs">{countsText(r)}</span> },
              { key: 'batchId', header: 'Batch', render: (r) => <span className="text-xs">{r.batchId ?? ''}</span> },
            ]} />
        </>
      )}
      <FormModal open={add} onClose={() => setAdd(false)} title="Add integration source" submitLabel="Create"
        onSubmit={async () => { const s = await api<{ id: string }>('/api/integrations/sources', { body: n }); router.push(`/integrations/sources/${s.id}`); }}>
        <Field label="Name" required><input className="input" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} required placeholder="e.g. Intune" /></Field>
        <Field label="Key" required hint="Used in the endpoint URL: lowercase letters, digits and dashes"><input className="input" value={n.key} onChange={(e) => setN({ ...n, key: e.target.value })} required placeholder="intune" /></Field>
        <Field label="Kind"><select className="input" value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}><option value="DEVICE">Device feed (push or pull)</option><option value="DIRECTORY">Directory (Active Directory / LDAP)</option></select></Field>
        <p className="text-xs text-slate-500">Every field starts on “queue a conflict for review”; change the rules on the next screen.</p>
      </FormModal>
    </div>
  );
}
export default function IntegrationsPage() { return <Suspense><Inner /></Suspense>; }
