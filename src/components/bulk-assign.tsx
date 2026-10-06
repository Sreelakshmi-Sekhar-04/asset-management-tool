'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { HolderPicker, type HolderValue } from './pickers';
import { ErrorBox, Field, Modal, Spinner } from './ui';

type Problem = { ref: string; message: string };
interface Result { holder: string; selected: number; assignable: number; assigned: number; skipped: Problem[]; failed: Problem[]; pendingApproval?: { requestNo: string } }

/**
 * Assign every selected asset to one holder. The holder and remarks are asked once; a check step
 * then shows how many will be assigned and which will be skipped before anything changes.
 */
export function BulkAssignDialog({ open, onClose, count, selection, onDone }: {
  open: boolean; onClose: () => void; count: number;
  /** `{ assetIds }` or `{ filter, excludeIds }`, as the other bulk actions send it. */
  selection: () => Record<string, unknown>;
  onDone: (r: Result) => void;
}) {
  const [holder, setHolder] = useState<HolderValue>(null);
  const [remarks, setRemarks] = useState('');
  const [check, setCheck] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (open) { setHolder(null); setRemarks(''); setCheck(null); setErr(null); } }, [open]);

  const send = (dryRun: boolean) => api<Result>('/api/assets/bulk-assign', { body: { ...selection(), holder: holder && { type: holder.type, id: holder.id }, remarks: remarks || null, dryRun } });
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!holder || busy) return;
    setBusy(true); setErr(null);
    try {
      if (!check) setCheck(await send(true));
      else { const r = await send(false); onDone(r); onClose(); }
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  const nothing = !!check && check.assignable === 0;
  return (
    <Modal open={open} onClose={onClose} title={`Assign ${count} asset${count === 1 ? '' : 's'}`}
      footer={<>
        {check && <button className="btn" type="button" onClick={() => { setCheck(null); setErr(null); }}>Back</button>}
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button form="bulk-assign" className="btn btn-primary" disabled={!holder || busy || nothing}>
          {busy && <Spinner className="h-3 w-3" />}{check ? `Confirm and assign ${check.assignable}` : 'Continue'}
        </button>
      </>}>
      <form id="bulk-assign" onSubmit={run} className="space-y-3">
        {!check ? <>
          <p className="text-sm text-slate-600">All {count} selected asset{count === 1 ? '' : 's'} go to the holder you choose. Each one gets its own assignment history entry.</p>
          <Field label="Assign to" required><HolderPicker value={holder} onChange={setHolder} /></Field>
          <Field label="Remarks"><textarea className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </> : <>
          <div className="rounded-md border bg-slate-50 px-3 py-2 text-sm">
            <div><b>{check.assignable}</b> of {check.selected} asset{check.selected === 1 ? '' : 's'} will be assigned to <b>{check.holder}</b>.</div>
            {remarks && <div className="mt-1 text-xs text-slate-500">Remarks: {remarks}</div>}
          </div>
          <ProblemList title="Skipped: already with this holder" items={check.skipped} tone="slate" />
          <ProblemList title="Cannot be assigned, left unchanged" items={check.failed} tone="amber" />
          {nothing && <p className="text-sm text-red-700">None of the selected assets can be assigned. Go back and choose another holder, or change the selection.</p>}
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

/** The toast after a bulk assignment: how many went through, and how many were left out. */
export function bulkAssignMessage(r: Result) {
  if (r.pendingApproval) return `Sent ${r.assignable} asset(s) for approval as ${r.pendingApproval.requestNo}`;
  const left = r.skipped.length + r.failed.length;
  return `${r.assigned} asset${r.assigned === 1 ? '' : 's'} assigned to ${r.holder}${left ? ` · ${left} left unchanged` : ''}`;
}
