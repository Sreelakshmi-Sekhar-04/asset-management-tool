'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, download, qs, useApi } from './api';
import { IMPORT_TYPE, ImportStatus, RUNNING } from './import-status';
import { DataTable, FilterSelect, useListState } from './list';
import { useMe } from './me';
import { Card, ErrorBox, Field, Spinner, useToast } from './ui';

interface Job { id: string; type: string; mode: string; fileName: string; status: string; totalRows: number; processedRows: number; counts: Record<string, number>; createdByName: string; createdAt: string; committedAt: string | null }

/**
 * Upload form and history for CSV / Excel imports. With assetsOnly (the "Upload Excel" tab of
 * Bulk add / Import) the type is fixed to assets and, instead of the full history, only imports
 * still running or waiting to be confirmed are listed, with a link to the history.
 */
export function ImportPanel({ assetsOnly = false }: { assetsOnly?: boolean }) {
  const me = useMe();
  const router = useRouter();
  const toast = useToast();
  const ls = useListState();
  const listUrl = assetsOnly ? `/api/imports${qs({ type: 'ASSETS', pageSize: 20 })}` : `/api/imports?${ls.apiQuery}`;
  const { data, error, loading, reload } = useApi<{ rows: Job[]; total: number }>(listUrl);
  const [type, setType] = useState('ASSETS');
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
    form.set('file', f); form.set('type', type); form.set('createMissing', String(type === 'EMPLOYEES' && createMissing));
    try { const j = await api<{ id: string }>('/api/imports', { form }); toast('Uploaded. The dry run has started.'); router.push(`/imports/${j.id}`); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card title={assetsOnly ? 'Upload an Excel or CSV file' : 'New import'}>
        <form onSubmit={upload} className="space-y-3">
          <div className={assetsOnly ? 'grid gap-3 md:grid-cols-2' : 'grid gap-3 md:grid-cols-3'}>
            {!assetsOnly && (
              <Field label="What to import">
                <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="ASSETS">Assets</option><option value="EMPLOYEES">Employees</option>{me.isAdmin && <option value="BRANCH_USERS">Branch users</option>}
                </select>
              </Field>
            )}
            <Field label="File (.csv or .xlsx, up to 20,000 rows)"><input ref={file} type="file" accept=".csv,.xlsx" className="input" /></Field>
            <div className="flex items-end"><button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Upload and dry run</button></div>
          </div>
          {/* Asset imports never create master data: a missing location or department is added from the preview. */}
          {type === 'EMPLOYEES' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />Create locations and departments that don’t exist yet (listed in the dry run before you confirm)</label>}
          {assetsOnly && <p className="text-xs text-slate-500">Each row is matched against the register by serial number, then legacy tag: new assets are created, existing ones updated, and rows already in the register with the same details are shown as duplicates. In the preview you can correct any row, scan or type missing serial numbers, add a location or department that does not exist yet, remove rows and choose which rows to import, before you confirm.</p>}
          <div className="flex flex-wrap gap-2 text-sm">
            Template: <button type="button" className="underline" onClick={() => download(`/api/imports/template?type=${type}&format=xlsx`)}>Excel</button>
            <button type="button" className="underline" onClick={() => download(`/api/imports/template?type=${type}&format=csv`)}>CSV</button>
            <span className="text-slate-500">(the Excel template has a Help sheet describing every column)</span>
          </div>
          <ErrorBox error={err} />
        </form>
      </Card>
      {assetsOnly ? <PendingAssetImports rows={data?.rows ?? []} error={error} /> : <>
        <div className="flex gap-2"><FilterSelect label="Type" value={ls.get('type')} onChange={(v) => ls.set('type', v)} options={Object.entries(IMPORT_TYPE).map(([value, label]) => ({ value, label }))} /></div>
        <ErrorBox error={error} />
        <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} empty="No imports yet."
          columns={[
            { key: 'createdAt', header: 'Started', className: 'whitespace-nowrap', render: (r) => <Link href={`/imports/${r.id}`}>{fmtDateTime(r.createdAt)}</Link> },
            { key: 'fileName', header: 'File', render: (r) => <Link href={`/imports/${r.id}`}>{r.fileName}</Link> },
            { key: 'type', header: 'Type', render: (r) => IMPORT_TYPE[r.type] },
            { key: 'status', header: 'Status', render: (r) => <ImportStatus s={r.status} /> },
            { key: 'rows', header: 'Rows', render: (r) => RUNNING.includes(r.status) ? `${r.processedRows}/${r.totalRows || '…'}` : r.totalRows },
            { key: 'counts', header: 'Result', render: (r) => <span className="text-xs">{r.counts?.total !== undefined ? `${r.counts.CREATED} new · ${r.counts.UPDATED} updated · ${r.counts.UNCHANGED ?? 0} duplicate · ${r.counts.WARNING} to review · ${r.counts.REJECTED} invalid` : ''}</span> },
            { key: 'createdByName', header: 'By' },
          ]} />
      </>}
    </div>
  );
}

/**
 * Asset imports that still need attention: a dry run in progress, or one waiting for "Confirm".
 * Finished imports live in the history (/imports), kept for the audit trail and error reports.
 */
function PendingAssetImports({ rows, error }: { rows: Job[]; error: unknown }) {
  const open = rows.filter((r) => RUNNING.includes(r.status) || r.status === 'VALIDATED');
  return (
    <div className="space-y-2">
      <ErrorBox error={error} />
      {open.length > 0 && (
        <Card title="Waiting for you">
          <ul className="divide-y text-sm">
            {open.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/imports/${r.id}`} className="font-medium">{r.fileName}</Link>
                <ImportStatus s={r.status} />
                <span className="text-xs text-slate-500">{fmtDateTime(r.createdAt)} · {r.createdByName}</span>
                <Link href={`/imports/${r.id}`} className="btn btn-sm ml-auto">{r.status === 'VALIDATED' ? 'Review and confirm' : 'Open'}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-right text-sm"><Link href="/imports?type=ASSETS">Import history</Link></p>
    </div>
  );
}
