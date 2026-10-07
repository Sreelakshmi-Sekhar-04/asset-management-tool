'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { EmployeePicker, useLocations } from './pickers';
import { ErrorBox, Field, Modal, Spinner } from './ui';

type Problem = { ref: string; message: string };
type Mode = 'ASSIGN' | 'TRANSFER';
interface Result {
  mode: Mode; holder: string; selected: number; assignable: number; assigned: number; released: number;
  skipped: Problem[]; failed: Problem[]; pendingApproval?: { requestNo: string };
}
type Target = { type: 'EMPLOYEE'; id: string; label: string } | { type: 'LOCATION'; id: string; label: string } | null;

/**
 * The asset register's one way to assign and to transfer (§2, §3, §6).
 *   one asset   → Assign to: an Employee, or a Location, which is a transfer;
 *   many assets → Transfer to: a Location, all of them in a single action.
 * The destination is asked once, then a check step says exactly what will happen — how many will
 * move, which are skipped and which cannot — before anything changes.
 */
export function BulkAssignDialog({ open, onClose, count, selection, onDone }: {
  open: boolean; onClose: () => void; count: number;
  /** `{ assetIds }` or `{ filter, excludeIds }`, as the other bulk actions send it. */
  selection: () => Record<string, unknown>;
  onDone: (r: Result) => void;
}) {
  const many = count > 1;
  const [kind, setKind] = useState<'EMPLOYEE' | 'LOCATION'>(many ? 'LOCATION' : 'EMPLOYEE');
  const [target, setTarget] = useState<Target>(null);
  const [remarks, setRemarks] = useState('');
  const [check, setCheck] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // The organization itself is the context, not a destination: offer the locations under it.
  const { data: allLocations } = useLocations();
  const locations = (allLocations ?? []).filter((l) => l.type !== 'ORGANIZATION');
  useEffect(() => {
    if (open) { setKind(many ? 'LOCATION' : 'EMPLOYEE'); setTarget(null); setRemarks(''); setCheck(null); setErr(null); }
  }, [open, many]);

  const transfer = kind === 'LOCATION';
  const send = (dryRun: boolean) => api<Result>('/api/assets/bulk-assign', { body: { ...selection(), holder: target && { type: target.type, id: target.id }, remarks: remarks || null, dryRun } });
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!target || busy) return;
    setBusy(true); setErr(null);
    try {
      if (!check) setCheck(await send(true));
      else { const r = await send(false); onDone(r); onClose(); }
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  const nothing = !!check && check.assignable === 0;
  const title = many ? `Transfer ${count} assets` : 'Assign asset';
  const confirm = check ? (check.mode === 'TRANSFER' ? `Confirm transfer of ${check.assignable}` : `Confirm assignment of ${check.assignable}`) : 'Continue';
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        {check && <button className="btn" type="button" onClick={() => { setCheck(null); setErr(null); }}>Back</button>}
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button form="bulk-assign" className="btn btn-primary" disabled={!target || busy || nothing}>
          {busy && <Spinner className="h-3 w-3" />}{confirm}
        </button>
      </>}>
      <form id="bulk-assign" onSubmit={run} className="space-y-3">
        {!check ? <>
          {many ? (
            <p className="text-sm text-slate-600">
              All {count} selected assets move to the location you choose. Moving assets to another location is a <b>transfer</b>: each asset&apos;s current location,
              status, assignment history and timestamps are updated in one action.
            </p>
          ) : (
            <Field label="Assign to" required>
              <div className="flex flex-col gap-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={kind === 'EMPLOYEE'} onChange={() => { setKind('EMPLOYEE'); setTarget(null); }} />
                  Employee <span className="text-slate-500">— the asset is held by that person</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={kind === 'LOCATION'} onChange={() => { setKind('LOCATION'); setTarget(null); }} />
                  Location (transfer) <span className="text-slate-500">— the asset moves to that location</span>
                </label>
              </div>
            </Field>
          )}
          {transfer ? (
            <Field label={many ? 'Transfer to' : 'Location'} required>
              <select className="input" value={target?.type === 'LOCATION' ? target.id : ''} required
                onChange={(e) => { const l = locations.find((x) => x.id === e.target.value); setTarget(l ? { type: 'LOCATION', id: l.id, label: l.namePath } : null); }}>
                <option value="">Choose the destination location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.namePath}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">Only locations in your organization are listed.</p>
            </Field>
          ) : (
            <Field label="Employee" required>
              <EmployeePicker value={target?.type === 'EMPLOYEE' ? target : null} onChange={(v) => setTarget(v ? { type: 'EMPLOYEE', ...v } : null)} />
              <p className="mt-1 text-xs text-slate-500">Only employees in your organization are listed.</p>
            </Field>
          )}
          <Field label="Remarks"><textarea className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </> : <>
          <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm">
            <div>
              <b>{check.assignable}</b> of {check.selected} asset{check.selected === 1 ? '' : 's'} will be {check.mode === 'TRANSFER' ? <>transferred to <b>{check.holder}</b></> : <>assigned to <b>{check.holder}</b></>}.
            </div>
            {check.mode === 'TRANSFER' && check.released > 0 && (
              <div className="mt-1 text-xs text-amber-700">{check.released} asset{check.released === 1 ? ' is' : 's are'} currently held by a person or a department; the holding ends when the asset moves, and it arrives In stock.</div>
            )}
            {remarks && <div className="mt-1 text-xs text-slate-500">Remarks: {remarks}</div>}
          </div>
          <ProblemList title={check.mode === 'TRANSFER' ? 'Skipped: already at this location' : 'Skipped: already with this holder'} items={check.skipped} tone="slate" />
          <ProblemList title={check.mode === 'TRANSFER' ? 'Cannot be transferred, left unchanged' : 'Cannot be assigned, left unchanged'} items={check.failed} tone="amber" />
          {nothing && <p className="text-sm text-red-700">None of the selected assets can move. Go back and choose another destination, or change the selection.</p>}
        </>}
        <ErrorBox error={err} />
      </form>
    </Modal>
  );
}

function ProblemList({ title, items, tone }: { title: string; items: Problem[]; tone: 'slate' | 'amber' }) {
  if (!items.length) return null;
  return (
    <div className={tone === 'amber' ? 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2' : 'rounded-md border px-3 py-2'}>
      <div className="text-xs font-semibold text-slate-700">{title} ({items.length})</div>
      <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5 text-xs text-slate-700">
        {items.slice(0, 200).map((p) => <li key={p.ref}><b>{p.ref}:</b> {p.message}</li>)}
        {items.length > 200 && <li>… and {items.length - 200} more</li>}
      </ul>
    </div>
  );
}

/** The toast afterwards: how many went through, and how many were left out. */
export function bulkAssignMessage(r: Result) {
  const what = r.mode === 'TRANSFER' ? 'transferred to' : 'assigned to';
  if (r.pendingApproval) return `Sent ${r.assignable} asset(s) for approval as ${r.pendingApproval.requestNo}`;
  const left = r.skipped.length + r.failed.length;
  return `${r.assigned} asset${r.assigned === 1 ? '' : 's'} ${what} ${r.holder}${left ? ` · ${left} left unchanged` : ''}`;
}
