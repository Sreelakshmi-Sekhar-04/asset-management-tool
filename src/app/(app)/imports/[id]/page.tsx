'use client';
import { useParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, download, qs, useApi } from '@/components/api';
import { IMPORT_TYPE, ImportStatus, RUNNING } from '@/components/import-status';
import { DataTable, useListState } from '@/components/list';
import { Badge, Card, ErrorBox, Field, PageHeader, Spinner, Stat, useConfirm, useToast } from '@/components/ui';

interface Job { id: string; type: string; mode: string; createMissing: boolean; fileName: string; status: string; totalRows: number; processedRows: number; counts: Record<string, number>; locationsToCreate: string[]; departmentsToCreate: string[]; warningReason: string | null; error: string | null; createdByName: string; createdAt: string; validatedAt: string | null; committedAt: string | null; reportPurgedAt: string | null }
interface Row { id: string; rowNumber: number; data: Record<string, string>; outcome: string; messages: string[]; resultCode: string | null }

const OUT_TONE: Record<string, string> = { CREATED: 'green', UPDATED: 'blue', UNCHANGED: 'gray', WARNING: 'amber', REJECTED: 'red' };
const OUT_LABEL: Record<string, string> = { CREATED: 'Create', UPDATED: 'Update', UNCHANGED: 'Unchanged', WARNING: 'Warning', REJECTED: 'Rejected' };

function Inner() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const ls = useListState();
  const { data: job, error, reload } = useApi<Job>(`/api/imports/${id}`);
  const rows = useApi<{ rows: Row[]; total: number }>(job && job.status !== 'QUEUED' && job.status !== 'VALIDATING' ? `/api/imports/${id}/rows${qs({ outcome: ls.get('outcome'), page: ls.page, pageSize: ls.pageSize })}` : null, [job?.status]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const running = job && RUNNING.includes(job.status);
  useEffect(() => { if (!running) return; const t = setInterval(reload, 2000); return () => clearInterval(t); }, [running, reload]);
  if (error) return <ErrorBox error={error} />;
  if (!job) return <div className="flex justify-center py-20"><Spinner /></div>;
  const c = job.counts ?? {};
  const committable = (c.CREATED ?? 0) + (c.UPDATED ?? 0) + (c.WARNING ?? 0);
  const committed = job.status === 'COMMITTED';
  const verb = committed ? '' : ' (planned)';

  const confirmImport = async () => {
    if (!(await confirm(`Commit this import? ${c.CREATED} record(s) will be created and ${c.UPDATED} updated${c.WARNING ? `, plus ${c.WARNING} with duplicate warnings` : ''}. Rejected and unchanged rows are skipped. The data is re-checked first; if anything changed since the dry run, nothing is applied.`))) return;
    setBusy(true); setErr(null);
    try { await api(`/api/imports/${id}/confirm`, { body: { warningReason: reason || undefined } }); toast('Commit started'); reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {node}
      <PageHeader back={{ href: '/imports', label: 'Imports' }} title={job.fileName}
        subtitle={<span className="flex flex-wrap items-center gap-2">{IMPORT_TYPE[job.type]} · {job.mode === 'CREATE_ONLY' ? 'create new only' : 'create or update'} · by {job.createdByName} {fmtDateTime(job.createdAt)} <ImportStatus s={job.status} /></span>}
        actions={<>
          {!running && job.totalRows > 0 && !job.reportPurgedAt && <button className="btn" onClick={() => download(`/api/imports/${id}/report`).catch((e) => toast(e.message, 'err'))}>Download row report</button>}
          {['QUEUED', 'VALIDATED', 'FAILED'].includes(job.status) && <button className="btn btn-ghost" onClick={async () => { if (await confirm('Cancel this import? Nothing has been saved.')) { await api(`/api/imports/${id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message, 'err')); reload(); } }}>Cancel import</button>}
        </>} />

      {running && (
        <Card><div className="flex items-center gap-3 text-sm"><Spinner />{job.status === 'VALIDATING' || job.status === 'QUEUED' ? 'Running dry run' : 'Committing'}… {job.processedRows.toLocaleString('en-IN')} of {job.totalRows ? job.totalRows.toLocaleString('en-IN') : '…'} rows</div>
          {job.totalRows > 0 && <div className="mt-2 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-brand-600 transition-all" style={{ width: `${Math.min(100, (job.processedRows / job.totalRows) * 100)}%` }} /></div>}
        </Card>
      )}
      {job.error && <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{job.error}</div>}

      {c.total !== undefined && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label={`Created${verb}`} value={c.CREATED} tone="green" /><Stat label={`Updated${verb}`} value={c.UPDATED} /><Stat label="Unchanged" value={c.UNCHANGED} />
          <Stat label="Duplicate warnings" value={c.WARNING} tone={c.WARNING ? 'amber' : undefined} /><Stat label="Rejected" value={c.REJECTED} tone={c.REJECTED ? 'red' : undefined} />
        </div>
      )}

      {job.status === 'VALIDATED' && (
        <Card title="Confirm and commit">
          <div className="space-y-3 text-sm">
            {(job.locationsToCreate.length > 0 || job.departmentsToCreate.length > 0) && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                {job.locationsToCreate.length > 0 && <div><b>New locations that will be created:</b> {job.locationsToCreate.join(', ')}</div>}
                {job.departmentsToCreate.length > 0 && <div><b>New departments that will be created:</b> {job.departmentsToCreate.join(', ')}</div>}
              </div>
            )}
            {c.WARNING > 0 && <Field label={`Reason for accepting ${c.WARNING} duplicate warning(s)`} required><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded on each affected asset" /></Field>}
            {committable === 0 ? <p className="text-slate-600">Nothing to commit: every row is unchanged or rejected. Fix the rejected rows using the row report and upload again.</p>
              : <button className="btn btn-primary" disabled={busy || (c.WARNING > 0 && !reason.trim())} onClick={confirmImport}>{busy && <Spinner className="h-3 w-3" />}Commit {committable.toLocaleString('en-IN')} row(s)</button>}
            <ErrorBox error={err} />
          </div>
        </Card>
      )}
      {committed && <p className="text-sm text-slate-600">Committed {fmtDateTime(job.committedAt)}{job.warningReason ? `; duplicate warnings accepted with reason “${job.warningReason}”` : ''}.</p>}

      {rows.data && (
        <>
          <div className="flex flex-wrap gap-1">
            {['', 'CREATED', 'UPDATED', 'UNCHANGED', 'WARNING', 'REJECTED'].map((o) => (
              <button key={o} className={`btn btn-sm ${ls.get('outcome') === o ? 'btn-primary' : ''}`} onClick={() => ls.set('outcome', o)}>{o ? OUT_LABEL[o] : 'All rows'}{o && c[o] !== undefined ? ` (${c[o]})` : ''}</button>
            ))}
          </div>
          <DataTable loading={rows.loading} rows={rows.data.rows} total={rows.data.total} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))}
            columns={[
              { key: 'rowNumber', header: 'Row', render: (r) => r.rowNumber },
              { key: 'outcome', header: 'Result', render: (r) => <Badge tone={OUT_TONE[r.outcome]}>{OUT_LABEL[r.outcome]}</Badge> },
              { key: 'messages', header: 'Reason', render: (r) => <span className="text-xs">{r.messages.join(' ')}</span> },
              { key: 'resultCode', header: 'Record', render: (r) => r.resultCode ?? '' },
              { key: 'data', header: 'Data', render: (r) => <span className="text-xs text-slate-600">{Object.entries(r.data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ').slice(0, 240)}</span> },
            ]} />
        </>
      )}
    </div>
  );
}

export default function ImportPage() { return <Suspense><Inner /></Suspense>; }
