'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, download, useApi } from '@/components/api';
import { IMPORT_TYPE, ImportStatus, RUNNING } from '@/components/import-status';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { useMe } from '@/components/me';
import { Card, ErrorBox, Field, PageHeader, Spinner, useToast } from '@/components/ui';

interface Job { id: string; type: string; mode: string; fileName: string; status: string; totalRows: number; processedRows: number; counts: Record<string, number>; createdByName: string; createdAt: string; committedAt: string | null }

function Inner() {
  const me = useMe();
  const router = useRouter();
  const toast = useToast();
  const ls = useListState();
  const { data, error, loading, reload } = useApi<{ rows: Job[]; total: number }>(`/api/imports?${ls.apiQuery}`);
  const [type, setType] = useState('ASSETS');
  const [mode, setMode] = useState('CREATE_ONLY');
  const [createMissing, setCreateMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const file = useRef<HTMLInputElement>(null);
  const running = data?.rows.some((r) => RUNNING.includes(r.status));
  useEffect(() => { if (!running) return; const t = setInterval(reload, 3000); return () => clearInterval(t); }, [running, reload]);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f) { setErr(new Error('Choose a CSV or Excel file.')); return; }
    setBusy(true); setErr(null);
    const form = new FormData();
    form.set('file', f); form.set('type', type); form.set('mode', mode); form.set('createMissing', String(createMissing));
    try { const j = await api<{ id: string }>('/api/imports', { form }); toast('Uploaded. The dry run has started.'); router.push(`/imports/${j.id}`); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Import" subtitle="Upload a CSV or Excel file. A dry run shows exactly what will happen; nothing is saved until you confirm." />
      <Card title="New import">
        <form onSubmit={upload} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="What to import">
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="ASSETS">Assets</option><option value="EMPLOYEES">Employees</option>{me.isAdmin && <option value="BRANCH_USERS">Branch users</option>}
              </select>
            </Field>
            <Field label="Mode">
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value)} disabled={type === 'BRANCH_USERS'}>
                <option value="CREATE_ONLY">Create new only</option><option value="CREATE_OR_UPDATE">Create or update existing</option>
              </select>
            </Field>
            <Field label="File (.csv or .xlsx, up to 20,000 rows)"><input ref={file} type="file" accept=".csv,.xlsx" className="input" /></Field>
            <div className="flex items-end"><button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Upload and dry run</button></div>
          </div>
          {type !== 'BRANCH_USERS' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />Create locations and departments that don’t exist yet (listed in the dry run before you confirm)</label>}
          <div className="flex flex-wrap gap-2 text-sm">
            Template: <button type="button" className="underline" onClick={() => download(`/api/imports/template?type=${type}&format=xlsx`)}>Excel</button>
            <button type="button" className="underline" onClick={() => download(`/api/imports/template?type=${type}&format=csv`)}>CSV</button>
            <span className="text-slate-500">(the Excel template has a Help sheet describing every column)</span>
          </div>
          <ErrorBox error={err} />
        </form>
      </Card>
      <div className="flex gap-2"><FilterSelect label="Type" value={ls.get('type')} onChange={(v) => ls.set('type', v)} options={Object.entries(IMPORT_TYPE).map(([value, label]) => ({ value, label }))} /></div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="No imports yet."
        columns={[
          { key: 'createdAt', header: 'Started', className: 'whitespace-nowrap', render: (r) => <Link href={`/imports/${r.id}`}>{fmtDateTime(r.createdAt)}</Link> },
          { key: 'fileName', header: 'File', render: (r) => <Link href={`/imports/${r.id}`}>{r.fileName}</Link> },
          { key: 'type', header: 'Type', render: (r) => IMPORT_TYPE[r.type] },
          { key: 'status', header: 'Status', render: (r) => <ImportStatus s={r.status} /> },
          { key: 'rows', header: 'Rows', render: (r) => RUNNING.includes(r.status) ? `${r.processedRows}/${r.totalRows || '…'}` : r.totalRows },
          { key: 'counts', header: 'Result', render: (r) => <span className="text-xs">{r.counts?.total !== undefined ? `${r.counts.CREATED} new · ${r.counts.UPDATED} updated · ${r.counts.WARNING} warnings · ${r.counts.REJECTED} rejected` : ''}</span> },
          { key: 'createdByName', header: 'By' },
        ]} />
    </div>
  );
}

export default function ImportsPage() { return <Suspense><Inner /></Suspense>; }
