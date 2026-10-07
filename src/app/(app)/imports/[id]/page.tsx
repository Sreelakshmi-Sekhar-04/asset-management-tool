'use client';
import { useParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { parseDate } from '@/lib/parse-date';
import { api, download, qs, useApi } from '@/components/api';
import { IMPORT_TYPE, ImportStatus, RUNNING } from '@/components/import-status';
import { importAssetColumns, MORE_FIELDS, OUT_LABEL, OUT_TONE, type ImportAssetRow, type RowEditor } from '@/components/import-asset-rows';
import { CameraScanner } from '@/components/camera-scanner';
import { DataTable, useListState } from '@/components/list';
import { useCategories, useLocations } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, Modal, PageHeader, Spinner, Stat, useConfirm, useToast } from '@/components/ui';

interface Job { id: string; type: string; mode: string; createMissing: boolean; fileName: string; status: string; totalRows: number; processedRows: number; counts: Record<string, number>; locationsToCreate: string[]; departmentsToCreate: string[]; warningReason: string | null; error: string | null; createdByName: string; createdAt: string; validatedAt: string | null; committedAt: string | null; reportPurgedAt: string | null }
type Row = ImportAssetRow;

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
  const editor = useRowEditor(id, job?.type === 'ASSETS' && job.status === 'VALIDATED', () => { reload(); rows.reload(); });
  if (error) return <ErrorBox error={error} />;
  if (!job) return <div className="flex justify-center py-20"><Spinner /></div>;
  const c = job.counts ?? {};
  const committable = (c.CREATED ?? 0) + (c.UPDATED ?? 0) + (c.WARNING ?? 0);
  const committed = job.status === 'COMMITTED';
  const verb = committed ? '' : ' (planned)';

  const confirmImport = async () => {
    if (!(await confirm(`Confirm this import? ${c.CREATED} record(s) will be created and ${c.UPDATED} updated${c.WARNING ? `, plus ${c.WARNING} with duplicate warnings` : ''}, using the values shown in the table, including your corrections. Rejected and duplicate rows are skipped. The data is re-checked first; if anything changed since the last check, nothing is applied.`))) return;
    setBusy(true); setErr(null);
    try { await api(`/api/imports/${id}/confirm`, { body: { warningReason: reason || undefined } }); toast('Commit started'); reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {node}
      <PageHeader back={job.type === 'ASSETS' ? { href: '/assets/new?tab=excel', label: 'Create asset' } : { href: '/imports', label: 'Imports' }} title={job.fileName}
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
          <Stat label={`Created${verb}`} value={c.CREATED} tone="green" /><Stat label={`Updated${verb}`} value={c.UPDATED} /><Stat label="Duplicate" value={c.UNCHANGED} />
          <Stat label="Duplicate warnings" value={c.WARNING} tone={c.WARNING ? 'amber' : undefined} /><Stat label="Rejected" value={c.REJECTED} tone={c.REJECTED ? 'red' : undefined} />
        </div>
      )}

      {job.status === 'VALIDATED' && (
        <Card title="Review, fix and confirm" actions={editor && <button className="btn btn-sm" disabled={busy || editor.editing !== null || editor.saving} onClick={editor.recheck}>{editor.saving && editor.editing === null && <Spinner className="h-3 w-3" />}Check again</button>}>
          <div className="space-y-3 text-sm">
            {editor && <p className="text-slate-600">Nothing is imported yet. Click any cell in the table to correct it, or use <b>Scan</b> or <b>Enter manually</b> on a row with no serial number. Each saved row is checked again straight away, and the import uses the corrected values.</p>}
            {editor && (c.REJECTED ?? 0) > 0 && <p className="text-red-800">{c.REJECTED} row(s) still have problems and will be skipped unless you fix them. <button className="underline" onClick={() => ls.set('outcome', 'REJECTED')}>Show them</button></p>}
            {(job.locationsToCreate.length > 0 || job.departmentsToCreate.length > 0) && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                {job.locationsToCreate.length > 0 && <div><b>New locations that will be created:</b> {job.locationsToCreate.join(', ')}</div>}
                {job.departmentsToCreate.length > 0 && <div><b>New departments that will be created:</b> {job.departmentsToCreate.join(', ')}</div>}
              </div>
            )}
            {c.WARNING > 0 && <Field label={`Reason for accepting ${c.WARNING} duplicate warning(s)`} required><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded on each affected asset" /></Field>}
            {committable === 0 ? <p className="text-slate-600">Nothing to import yet: every row is a duplicate or rejected.{editor ? ' Fix the rejected rows in the table below.' : ' Fix the rejected rows using the row report and upload again.'}</p>
              : <button className="btn btn-primary" disabled={busy || !!editor?.editing || !!editor?.saving || (c.WARNING > 0 && !reason.trim())} onClick={confirmImport}>{busy && <Spinner className="h-3 w-3" />}Confirm and import {committable.toLocaleString('en-IN')} row(s)</button>}
            {editor?.editing != null && <p className="text-xs text-amber-800">Save or cancel your changes to row {editor.editing} first.</p>}
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
            columns={job.type === 'ASSETS' ? importAssetColumns(editor ?? undefined) : [
              { key: 'rowNumber', header: 'Row', render: (r) => r.rowNumber },
              { key: 'outcome', header: 'Result', render: (r) => <Badge tone={OUT_TONE[r.outcome]}>{OUT_LABEL[r.outcome]}</Badge> },
              { key: 'messages', header: 'Reason', render: (r) => <span className="text-xs">{r.messages.join(' ')}</span> },
              { key: 'resultCode', header: 'Record', render: (r) => r.resultCode ?? '' },
              { key: 'data', header: 'Data', render: (r) => <span className="text-xs text-slate-600">{Object.entries(r.data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ').slice(0, 240)}</span> },
            ]} />
        </>
      )}
      {editor?.dialogs}
    </div>
  );
}

/**
 * State for correcting rows of an asset dry run in the preview: one row is edited at a time, and the
 * camera fills the serial of the row whose Scan button was pressed, never another row.
 * Returns null when the import cannot be edited (any other status, or not an asset import).
 */
function useRowEditor(jobId: string, enabled: boolean, onSaved: () => void) {
  const toast = useToast();
  const cats = useCategories();
  const locs = useLocations();
  const [row, setRow] = useState<ImportAssetRow | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [scanFor, setScanFor] = useState<ImportAssetRow | null>(null);
  const [typed, setTyped] = useState('');

  const save = useCallback(async (rowNumber: number, data: Record<string, string>) => {
    setSaving(true); setErr(null);
    try {
      const r = await api<{ counts: Record<string, number>; changed: boolean }>(`/api/imports/${jobId}/rows/${rowNumber}`, { method: 'PATCH', body: { data } });
      toast(r.changed ? `Row ${rowNumber} saved and checked again.` : `Row ${rowNumber} had no changes.`);
      setRow(null); setDraft({}); setMore(false);
      onSaved();
      return true;
    } catch (e) { setErr(e); toast((e as Error).message, 'err'); return false; } finally { setSaving(false); }
  }, [jobId, onSaved, toast]);

  if (!enabled) return null;

  const onScanned = async (text: string) => {
    const r = scanFor;
    const serial = text.trim();
    if (!r || !serial || saving) return;
    setScanFor(null); setTyped('');
    // Editing this row: fill the box and let Save store it with the other changes.
    if (row?.rowNumber === r.rowNumber) { setDraft((d) => ({ ...d, serialnumber: serial })); toast(`Scanned ${serial} into row ${r.rowNumber}. Save the row to keep it.`); return; }
    await save(r.rowNumber, { serialnumber: serial });
  };

  const editor: RowEditor & { recheck: () => void; dialogs: React.ReactNode } = {
    editing: row?.rowNumber ?? null, draft, focus, saving,
    start: (r, f) => { setRow(r); setDraft({ ...r.data }); setFocus(f ?? 'serialnumber'); setErr(null); },
    set: (k, v) => setDraft((d) => ({ ...d, [k]: v })),
    cancel: () => { setRow(null); setDraft({}); setMore(false); setErr(null); },
    save: () => {
      if (!row) return;
      const changed: Record<string, string> = {};
      for (const [k, v] of Object.entries(draft)) if ((row.data[k] ?? '') !== v) changed[k] = v;
      void save(row.rowNumber, changed);
    },
    scan: (r) => { setScanFor(r); setTyped(''); },
    more: () => setMore(true),
    categories: (cats.data ?? []).filter((c) => c.active).map((c) => c.name),
    locations: (locs.data ?? []).filter((l) => l.active).map((l) => l.namePath),
    recheck: async () => {
      setSaving(true);
      try { await api(`/api/imports/${jobId}/revalidate`, { method: 'POST' }); toast('Checked again.'); onSaved(); }
      catch (e) { toast((e as Error).message, 'err'); } finally { setSaving(false); }
    },
    dialogs: (
      <>
        <Modal open={!!scanFor} onClose={() => setScanFor(null)} title={`Scan the serial number for row ${scanFor?.rowNumber ?? ''}`}>
          {scanFor && (
            <div className="space-y-3 text-sm">
              <p className="text-slate-600">{[scanFor.data.make, scanFor.data.model].filter(Boolean).join(' ') || 'This row'}{scanFor.data.category ? ` · ${scanFor.data.category}` : ''}. Only this row gets the scanned serial.</p>
              <CameraScanner mode="serial" onScan={onScanned} paused={saving} />
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void onScanned(typed); }}>
                <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type it, or use a USB barcode scanner" aria-label="Serial number" />
                <button className="btn btn-primary" disabled={!typed.trim() || saving}>Use</button>
              </form>
            </div>
          )}
        </Modal>
        <Modal open={more && !!row} onClose={() => setMore(false)} title={`More fields for row ${row?.rowNumber ?? ''}`}
          footer={<><button className="btn" onClick={() => setMore(false)}>Back to the table</button><button className="btn btn-primary" disabled={saving} onClick={() => editor.save()}>{saving && <Spinner className="h-3 w-3" />}Save row</button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            {MORE_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                {f.type === 'date'
                  ? <input type="date" className="input" value={parseDate(draft[f.key] ?? '') ?? ''} onChange={(e) => editor.set(f.key, e.target.value)} />
                  : <input className="input" value={draft[f.key] ?? ''} onChange={(e) => editor.set(f.key, e.target.value)} />}
              </Field>
            ))}
          </div>
          {row && row.messages.filter((m) => /MAC|Purchase/.test(m)).map((m) => <p key={m} className="mt-2 text-xs text-red-700">{m}</p>)}
          <ErrorBox error={err} className="mt-2" />
        </Modal>
      </>
    ),
  };
  return editor;
}

export default function ImportPage() { return <Suspense><Inner /></Suspense>; }
