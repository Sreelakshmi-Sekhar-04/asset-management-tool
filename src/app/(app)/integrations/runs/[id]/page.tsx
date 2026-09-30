'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { fmtDateTime } from '@/lib/format';
import { api, useApi } from '@/components/api';
import { RunStatus, type RunCounts } from '@/components/integration-bits';
import { Badge, Card, ErrorBox, PageHeader, Spinner, Stat, useToast } from '@/components/ui';

interface Note { record: number; externalId?: string | null; serial?: string | null; level: 'error' | 'info'; message: string }
interface Run extends RunCounts { id: string; mode: string; status: string; batchId: string | null; startedAt: string; finishedAt: string | null; acknowledgedAt: string | null; retryOfRunId: string | null; errors: Note[]; source: { id: string; name: string; key: string } }

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data: r, error, reload } = useApi<Run>(`/api/integrations/runs/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <div className="flex justify-center py-20"><Spinner /></div>;
  const failed = r.status === 'FAILED' || r.status === 'PARTIAL';
  const act = async (path: 'retry' | 'acknowledge') => {
    try {
      const res = await api<{ runId?: string }>(`/api/integrations/runs/${id}/${path}`, { method: 'POST' });
      if (path === 'retry' && res.runId) { toast('Retried'); router.push(`/integrations/runs/${res.runId}`); } else { toast('Acknowledged'); reload(); }
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const errors = r.errors.filter((e) => e.level === 'error');
  const info = r.errors.filter((e) => e.level === 'info');
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: `/integrations/sources/${r.source.id}`, label: r.source.name }} title={`Run ${fmtDateTime(r.startedAt)}`}
        subtitle={<span className="flex items-center gap-2">{r.mode.toLowerCase()}{r.batchId ? ` · batch ${r.batchId}` : ''} <RunStatus s={r.status} />{r.acknowledgedAt && <Badge>Acknowledged {fmtDateTime(r.acknowledgedAt)}</Badge>}</span>}
        actions={failed && <>
          <button className="btn btn-primary" onClick={() => act('retry')}>Retry</button>
          {!r.acknowledgedAt && <button className="btn" onClick={() => act('acknowledge')}>Acknowledge</button>}
        </>} />
      {r.retryOfRunId && <p className="text-sm">Retry of <Link href={`/integrations/runs/${r.retryOfRunId}`}>an earlier run</Link>.</p>}
      <div className="grid grid-cols-3 gap-3 md:grid-cols-7">
        <Stat label="Received" value={r.received} /><Stat label="Created" value={r.created} /><Stat label="Updated" value={r.updated} /><Stat label="Unchanged" value={r.unchanged ?? 0} />
        <Stat label="Conflicts" value={r.conflicts} tone={r.conflicts ? 'amber' : undefined} /><Stat label="Unmatched" value={r.unmatched} tone={r.unmatched ? 'amber' : undefined} /><Stat label="Rejected" value={r.rejected} tone={r.rejected ? 'red' : undefined} />
      </div>
      <Card title={`Errors (${errors.length})`}>
        {errors.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Record</th><th>Identifier</th><th>Problem</th></tr></thead>
            <tbody>{errors.map((e, i) => <tr key={i}><td>{e.record || '—'}</td><td className="text-xs">{e.serial ?? e.externalId ?? ''}</td><td className="text-sm">{e.message}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      {info.length > 0 && <Card title={`Notes (${info.length})`}><ul className="space-y-1 text-xs">{info.slice(0, 200).map((e, i) => <li key={i}>Record {e.record}{e.serial ? ` (${e.serial})` : ''}: {e.message}</li>)}</ul></Card>}
    </div>
  );
}
