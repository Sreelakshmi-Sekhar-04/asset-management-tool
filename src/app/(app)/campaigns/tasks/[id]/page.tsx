'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { api, ApiError, download, qs, useApi } from '@/components/api';
import { DuplicateNotice } from '@/components/asset-form';
import { CameraScanner } from '@/components/camera-scanner';
import { DocumentsPanel } from '@/components/documents';
import { TaskStatus } from '@/components/badges';
import { DataTable, useListState } from '@/components/list';
import { useColumnFilters } from '@/components/list-filters';
import { useMe } from '@/components/me';
import { CategorySelect, EmployeePicker } from '@/components/pickers';
import { useScannerAdvance } from '@/components/scanner';
import { Badge, Card, ErrorBox, Field, FormModal, Modal, PageHeader, Spinner, Stat, Tabs, useConfirm, useToast } from '@/components/ui';

interface Stats { total: number; inTransit: number; present: number; missing: number; wrong: number; unmarked: number; unlisted: number; pendingReview: number; discrepancies: number }
interface Unlisted { id: string; category?: string; make: string; model: string; serialNumber: string | null; hostname: string | null; ipAddress: string | null; legacyTag: string | null; remarks: string | null; reviewStatus: string; reviewNote: string | null; createdAssetId: string | null }
interface Task {
  id: string; status: string; overdue: boolean; canEdit: boolean; canReview: boolean; submittedAt: string | null; submittedByName: string | null; signedOffAt: string | null; signedOffByName: string | null; signOffNote: string | null;
  location: { namePath: string }; campaign: { id: string; name: string; dueDate: string }; stats: Stats; unlisted: Unlisted[];
}
interface Snapshot { category?: string; make?: string; model?: string; serialNumber?: string | null; hostname?: string | null; ipAddress?: string | null; holder?: string | null; transfer?: string | null }
interface Line { id: string; assetId: string; assetCode: string; snapshot: Snapshot; result: string | null; correctedHostname: string | null; correctedIp: string | null; correctedHolderEmployeeId: string | null; correctedRemarks: string | null; note: string | null; reviewStatus: string | null; reviewNote: string | null }

const RESULT: Record<string, { label: string; tone: string }> = { PRESENT: { label: 'Present', tone: 'green' }, MISSING: { label: 'Missing', tone: 'red' }, WRONG_DETAILS: { label: 'Wrong details', tone: 'amber' } };
const REVIEW_TONE: Record<string, string> = { ACCEPTED: 'green', REJECTED: 'gray', PENDING: 'amber' };

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const ls = useListState({ tab: 'checklist' });
  const cf = useColumnFilters(ls);
  const tab = ls.get('tab');
  const { data: t, error, reload } = useApi<Task>(`/api/verification/tasks/${id}`);
  const lineQuery = qs({ search: ls.get('search'), result: ls.get('result'), inTransit: tab === 'transit' ? 'true' : undefined, page: ls.page, pageSize: ls.pageSize });
  const lines = useApi<{ rows: Line[]; total: number }>(tab === 'unlisted' ? null : `/api/verification/tasks/${id}/lines${lineQuery}`);
  const [wrong, setWrong] = useState<Line | null>(null);
  const [review, setReview] = useState<{ kind: 'line' | 'unlisted'; id: string; label: string; decision: 'ACCEPTED' | 'REJECTED' } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const refresh = () => { reload(); lines.reload(); };

  if (error) return <ErrorBox error={error} />;
  if (!t) return <div className="flex justify-center py-20"><Spinner /></div>;
  const s = t.stats;
  const isIT = me.isIT;
  const reviewing = isIT && t.status === 'SUBMITTED';

  const mark = async (l: Line, result: string) => {
    try { await api(`/api/verification/tasks/${id}/mark`, { body: { lines: [{ lineId: l.id, result }] } }); refresh(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const act = async (path: string, text: string, body?: unknown) => {
    try { await api(`/api/verification/tasks/${id}/${path}`, { method: 'POST', body }); toast(text); refresh(); } catch (e) { toast((e as Error).message, 'err'); }
  };

  const columns = [
    { key: 'assetCode', header: 'Asset ID', className: 'whitespace-nowrap', filter: cf.text('search', 'Asset', 'Asset ID, serial or hostname contains…'), render: (l: Line) => <Link href={`/assets/${l.assetId}`}>{l.assetCode}</Link> },
    { key: 'item', header: 'Item', render: (l: Line) => <div><div>{l.snapshot.make} {l.snapshot.model}</div><div className="text-xs text-slate-500">{l.snapshot.category}</div></div> },
    { key: 'serial', header: 'Serial / hostname', render: (l: Line) => <div className="text-xs"><div>{l.snapshot.serialNumber ?? '—'}</div><div className="text-slate-500">{l.snapshot.hostname ?? ''}{l.snapshot.ipAddress ? ` · ${l.snapshot.ipAddress}` : ''}</div></div> },
    { key: 'holder', header: tab === 'transit' ? 'Transfer' : 'Holder', render: (l: Line) => <span className="text-xs">{tab === 'transit' ? l.snapshot.transfer : l.snapshot.holder ?? '—'}</span> },
    ...(tab === 'transit' ? [] : [
      {
        key: 'result', header: 'Result', filter: cf.option('result', 'Result', [{ value: 'UNMARKED', label: 'Unmarked' }, { value: 'PRESENT', label: 'Present' }, { value: 'MISSING', label: 'Missing' }, { value: 'WRONG_DETAILS', label: 'Wrong details' }], 'Any result'), render: (l: Line) => (
          <div className="space-y-1">
            {t.canEdit ? (
              <div className="flex gap-1">
                {(['PRESENT', 'MISSING'] as const).map((r) => <button key={r} className={`btn btn-sm ${l.result === r ? (r === 'PRESENT' ? 'bg-green-600 text-white' : 'bg-red-600 text-white') : ''}`} onClick={() => mark(l, r)}>{RESULT[r].label}</button>)}
                <button className={`btn btn-sm ${l.result === 'WRONG_DETAILS' ? 'bg-amber-500 text-white' : ''}`} onClick={() => setWrong(l)}>Wrong details…</button>
              </div>
            ) : l.result ? <Badge tone={RESULT[l.result].tone}>{RESULT[l.result].label}</Badge> : <Badge>Unmarked</Badge>}
            {l.result === 'WRONG_DETAILS' && (
              <div className="text-xs text-slate-600">
                {[l.correctedHostname && `Hostname → ${l.correctedHostname}`, l.correctedIp && `IP → ${l.correctedIp}`, l.correctedHolderEmployeeId && 'Holder corrected', l.correctedRemarks && `Remarks: ${l.correctedRemarks}`].filter(Boolean).join(' · ')}
              </div>
            )}
            {l.note && <div className="text-xs italic text-slate-500">{l.note}</div>}
          </div>
        ),
      },
      {
        key: 'review', header: 'IT review', render: (l: Line) => {
          if (l.result !== 'MISSING' && l.result !== 'WRONG_DETAILS') return null;
          if (l.reviewStatus) return <div><Badge tone={REVIEW_TONE[l.reviewStatus]}>{l.reviewStatus === 'ACCEPTED' ? 'Accepted' : 'Rejected'}</Badge>{l.reviewNote && <div className="text-xs text-slate-500">{l.reviewNote}</div>}</div>;
          if (!reviewing) return <Badge tone="amber">Pending</Badge>;
          return (
            <div className="flex gap-1">
              <button className="btn btn-sm btn-primary" onClick={() => setReview({ kind: 'line', id: l.id, label: l.assetCode, decision: 'ACCEPTED' })}>Accept</button>
              <button className="btn btn-sm" onClick={() => setReview({ kind: 'line', id: l.id, label: l.assetCode, decision: 'REJECTED' })}>Reject</button>
            </div>
          );
        },
      },
    ]),
  ];

  return (
    <div className="space-y-4">
      {node}
      <PageHeader
        back={{ href: isIT ? `/campaigns/${t.campaign.id}` : '/campaigns', label: isIT ? t.campaign.name : 'Campaigns' }}
        title={t.location.namePath}
        subtitle={<span className="flex flex-wrap items-center gap-2">{t.campaign.name} · due {fmtDateOnly(t.campaign.dueDate)} <TaskStatus s={t.status} />{t.overdue && <Badge tone="red">Overdue</Badge>}</span>}
        actions={<>
          {t.canEdit && s.unmarked > 0 && <button className="btn" onClick={async () => { if (await confirm(`Mark all ${s.unmarked} unmarked asset(s) as Present? Only do this after physically seeing each one.`)) act('mark-all', 'Unmarked assets marked present'); }}>Mark all unmarked present</button>}
          {t.canEdit && <button className="btn btn-primary" onClick={async () => { if (await confirm('Submit this campaign task? The checklist locks and IT reviews the discrepancies.')) act('submit', 'Submitted to IT'); }}>Submit</button>}
          {reviewing && <button className="btn" onClick={() => setReopenOpen(true)}>Reopen</button>}
          {reviewing && <button className="btn btn-primary" disabled={s.pendingReview > 0} title={s.pendingReview ? 'Review every discrepancy first' : undefined} onClick={() => setSignOpen(true)}>Sign off</button>}
          {t.status === 'SIGNED_OFF' && <><button className="btn" onClick={() => download(`/api/verification/tasks/${id}/verified-stock?format=xlsx`).catch((e) => toast(e.message, 'err'))}>Verified stock (Excel)</button><button className="btn" onClick={() => download(`/api/verification/tasks/${id}/verified-stock?format=csv`).catch((e) => toast(e.message, 'err'))}>CSV</button></>}
        </>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="On checklist" value={s.total} hint={s.inTransit ? `${s.inTransit} in transit, excluded` : undefined} />
        <Stat label="Unmarked" value={s.unmarked} tone={s.unmarked && t.canEdit ? 'amber' : undefined} />
        <Stat label="Present" value={s.present} tone="green" />
        <Stat label="Missing" value={s.missing} tone={s.missing ? 'red' : undefined} />
        <Stat label="Wrong details" value={s.wrong} tone={s.wrong ? 'amber' : undefined} />
        <Stat label="Unlisted" value={s.unlisted} />
      </div>

      {(t.submittedAt || t.signedOffAt) && (
        <div className="text-sm text-slate-600">
          {t.status === 'SUBMITTED' && s.pendingReview > 0 && <b>{s.pendingReview} finding(s) awaiting IT review. </b>}
          {t.submittedAt && <>Submitted by {t.submittedByName} on {fmtDateTime(t.submittedAt)}. </>}
          {t.signedOffAt && <>Signed off by {t.signedOffByName} on {fmtDateTime(t.signedOffAt)}{t.signOffNote ? `: ${t.signOffNote}` : ''}.</>}
        </div>
      )}

      {t.canEdit && <ScanBox taskId={id} onDone={refresh} />}

      <Tabs value={tab} onChange={(k) => ls.setMany({ tab: k, result: null, search: null })} tabs={[
        { key: 'checklist', label: `Checklist (${s.total})` },
        { key: 'unlisted', label: `Unlisted (${s.unlisted})` },
        ...(s.inTransit ? [{ key: 'transit', label: `In transit (${s.inTransit})` }] : []),
      ]} />

      {tab === 'unlisted' ? (
        <Card title="Assets found here but not on the checklist" actions={t.canEdit && <button className="btn btn-sm btn-primary" onClick={() => setAddOpen(true)}>Add unlisted asset</button>}>
          {t.unlisted.length === 0 ? <div className="p-4 text-sm text-slate-500">None recorded.</div> : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Category</th><th>Make / model</th><th>Serial</th><th>Hostname / IP</th><th>Remarks</th><th>Review</th><th /></tr></thead>
              <tbody>{t.unlisted.map((u) => (
                <tr key={u.id}>
                  <td>{u.category}</td><td>{u.make} {u.model}</td><td>{u.serialNumber ?? '—'}{u.legacyTag && <div className="text-xs text-slate-500">Tag {u.legacyTag}</div>}</td>
                  <td className="text-xs">{u.hostname ?? ''}{u.ipAddress ? ` · ${u.ipAddress}` : ''}</td><td className="text-xs">{u.remarks}</td>
                  <td><Badge tone={REVIEW_TONE[u.reviewStatus]}>{u.reviewStatus === 'PENDING' ? 'Pending' : u.reviewStatus === 'ACCEPTED' ? 'Accepted' : 'Rejected'}</Badge>
                    {u.createdAssetId && <div className="text-xs"><Link href={`/assets/${u.createdAssetId}`}>Created asset</Link></div>}
                    {u.reviewNote && <div className="text-xs text-slate-500">{u.reviewNote}</div>}</td>
                  <td className="whitespace-nowrap text-right">
                    {t.canEdit && u.reviewStatus === 'PENDING' && <button className="btn btn-sm btn-ghost" onClick={async () => { if (await confirm('Remove this unlisted entry?')) { try { await api(`/api/verification/tasks/${id}/unlisted/${u.id}`, { method: 'DELETE' }); refresh(); } catch (e) { toast((e as Error).message, 'err'); } } }}>Remove</button>}
                    {reviewing && u.reviewStatus === 'PENDING' && <span className="flex justify-end gap-1">
                      <button className="btn btn-sm btn-primary" onClick={() => setReview({ kind: 'unlisted', id: u.id, label: `${u.make} ${u.model}`, decision: 'ACCEPTED' })}>Accept and create</button>
                      <button className="btn btn-sm" onClick={() => setReview({ kind: 'unlisted', id: u.id, label: `${u.make} ${u.model}`, decision: 'REJECTED' })}>Reject</button>
                    </span>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {tab === 'transit' && <p className="text-xs text-slate-500">These assets were in an open transfer when the checklist was generated, so they are excluded from this campaign.</p>}
          <DataTable columns={columns} rows={lines.data?.rows ?? []} total={lines.data?.total ?? 0} loading={lines.loading} page={ls.page} pageSize={ls.pageSize}
            onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} toolbar={cf.strip()} />
        </div>
      )}

      <DocumentsPanel entityType="VERIFICATION_TASK" entityId={id} canUpload={t.status !== 'SIGNED_OFF'} isAdmin={me.isAdmin} title="Documents (signed checklists, photos)" />

      <WrongDetailsModal line={wrong} taskId={id} onClose={() => setWrong(null)} onDone={refresh} />
      <ReviewModal r={review} taskId={id} onClose={() => setReview(null)} onDone={refresh} />
      <AddUnlistedModal open={addOpen} taskId={id} onClose={() => setAddOpen(false)} onDone={(dups) => { refresh(); if (dups) toast(`Added. ${dups} possible duplicate(s) found; IT will check them on review.`); }} />
      <TextModal open={signOpen} title="Sign off campaign task" label="Sign-off note" submitLabel="Sign off" required={false} onClose={() => setSignOpen(false)}
        onSubmit={async (note) => { await api(`/api/verification/tasks/${id}/sign-off`, { body: { note } }); toast('Signed off'); refresh(); }} />
      <TextModal open={reopenOpen} title="Reopen for the branch" label="Reason (sent to the branch)" submitLabel="Reopen" required onClose={() => setReopenOpen(false)}
        onSubmit={async (reason) => { await api(`/api/verification/tasks/${id}/reopen`, { body: { reason } }); toast('Reopened'); refresh(); }} />
    </div>
  );
}

function ScanBox({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const onKey = useScannerAdvance();
  const mark = async (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setBusy(true);
    try {
      const r = await api<{ assetCode: string }>(`/api/verification/tasks/${taskId}/scan`, { body: { code: c } });
      setLast({ ok: true, text: `${r.assetCode} marked present` }); onDone();
    } catch (e) { setLast({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); setCode(''); if (!camera) ref.current?.focus(); }
  };
  return (
    <div className="card card-body space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="scan">Scan or type</label>
        <input id="scan" ref={ref} data-scan className="input max-w-xs" placeholder="Asset ID, serial or legacy tag" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => onKey(e, () => mark(code))} autoFocus disabled={busy} />
        <button className="btn" onClick={() => mark(code)} disabled={busy || !code.trim()}>Mark present</button>
        <button className="btn" onClick={() => setCamera((c) => !c)}>{camera ? 'Close camera' : 'Scan with camera'}</button>
        {last && <span className={`text-sm ${last.ok ? 'text-green-700' : 'text-red-600'}`}>{last.text}</span>}
      </div>
      {camera && <CameraScanner className="max-w-sm" onScan={mark} paused={busy} />}
    </div>
  );
}

function WrongDetailsModal({ line, taskId, onClose, onDone }: { line: Line | null; taskId: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ hostname: '', ip: '', remarks: '', note: '' });
  const [holder, setHolder] = useState<{ id: string; label: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  if (line && key !== line.id) {
    setKey(line.id);
    setV({ hostname: line.correctedHostname ?? '', ip: line.correctedIp ?? '', remarks: line.correctedRemarks ?? '', note: line.note ?? '' });
    setHolder(line.correctedHolderEmployeeId ? { id: line.correctedHolderEmployeeId, label: 'Corrected holder (unchanged)' } : null);
  }
  return (
    <FormModal open={!!line} onClose={() => { setKey(null); onClose(); }} title={`Wrong details: ${line?.assetCode ?? ''}`} submitLabel="Save"
      onSubmit={async () => {
        if (!v.hostname && !v.ip && !v.remarks && !holder) throw new ApiError(400, 'VALIDATION', 'Enter at least one corrected value.');
        await api(`/api/verification/tasks/${taskId}/mark`, { body: { lines: [{ lineId: line!.id, result: 'WRONG_DETAILS', correctedHostname: v.hostname || null, correctedIp: v.ip || null, correctedHolderEmployeeId: holder?.id ?? null, correctedRemarks: v.remarks || null, note: v.note || null }] } });
        setKey(null); onDone();
      }}>
      <p className="text-xs text-slate-500">Record what you actually see. IT reviews the correction before the asset record changes.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Correct hostname" hint={line?.snapshot.hostname ? `Recorded: ${line.snapshot.hostname}` : undefined}><input className="input" value={v.hostname} onChange={(e) => setV({ ...v, hostname: e.target.value })} /></Field>
        <Field label="Correct IP address" hint={line?.snapshot.ipAddress ? `Recorded: ${line.snapshot.ipAddress}` : undefined}><input className="input" value={v.ip} onChange={(e) => setV({ ...v, ip: e.target.value })} /></Field>
      </div>
      <Field label="Actual holder" hint={line?.snapshot.holder ? `Recorded: ${line.snapshot.holder}` : undefined}><EmployeePicker value={holder} onChange={setHolder} /></Field>
      <Field label="Other corrections"><textarea className="input" rows={2} value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} /></Field>
      <Field label="Note"><input className="input" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
    </FormModal>
  );
}

function ReviewModal({ r, taskId, onClose, onDone }: { r: { kind: 'line' | 'unlisted'; id: string; label: string; decision: 'ACCEPTED' | 'REJECTED' } | null; taskId: string; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setNote(''); setReason(''); setErr(null); onClose(); };
  if (!r) return null;
  const accept = r.decision === 'ACCEPTED';
  const what = r.kind === 'line'
    ? (accept ? 'Accepting applies the branch’s finding: a Missing asset is flagged missing; corrected details are written to the asset record.' : 'Rejecting leaves the asset record unchanged.')
    : (accept ? 'Accepting creates a new asset at this branch from the details the branch entered.' : 'Rejecting discards the entry; no asset is created.');
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const path = r.kind === 'line' ? `lines/${r.id}/review` : `unlisted/${r.id}/review`;
      await api(`/api/verification/tasks/${taskId}/${path}`, { body: { decision: r.decision, note: note || undefined, duplicateReason: reason || undefined } });
      close(); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={close} title={`${accept ? 'Accept' : 'Reject'}: ${r.label}`}
      footer={<><button className="btn" onClick={close}>Cancel</button><button className={accept ? 'btn btn-primary' : 'btn'} disabled={busy} onClick={submit}>{busy && <Spinner className="h-3 w-3" />}{accept ? 'Accept' : 'Reject'}</button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{what}</p>
        <Field label="Review note"><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err ? <DuplicateNotice error={err} reason={reason} setReason={setReason} /> : null}
      </div>
    </Modal>
  );
}

function AddUnlistedModal({ open, taskId, onClose, onDone }: { open: boolean; taskId: string; onClose: () => void; onDone: (dups: number) => void }) {
  const empty = { categoryId: '', make: '', model: '', serialNumber: '', hostname: '', ipAddress: '', legacyTag: '', remarks: '' };
  const [v, setV] = useState(empty);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <FormModal open={open} onClose={() => { setV(empty); onClose(); }} title="Add unlisted asset" submitLabel="Add" wide
      onSubmit={async () => {
        const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() || null]));
        const r = await api<{ possibleDuplicates: unknown[] }>(`/api/verification/tasks/${taskId}/unlisted`, { body });
        setV(empty); onDone(r.possibleDuplicates.length);
      }}>
      <p className="text-xs text-slate-500">For an asset physically here that is not on the checklist. IT reviews it and creates the asset record.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Category" required><CategorySelect value={v.categoryId} onChange={(categoryId) => setV({ ...v, categoryId })} required /></Field>
        <Field label="Make" required><input className="input" value={v.make} onChange={set('make')} required /></Field>
        <Field label="Model" required><input className="input" value={v.model} onChange={set('model')} required /></Field>
        <Field label="Serial number"><input className="input" value={v.serialNumber} onChange={set('serialNumber')} /></Field>
        <Field label="Hostname"><input className="input" value={v.hostname} onChange={set('hostname')} /></Field>
        <Field label="IP address"><input className="input" value={v.ipAddress} onChange={set('ipAddress')} /></Field>
        <Field label="Legacy tag"><input className="input" value={v.legacyTag} onChange={set('legacyTag')} /></Field>
      </div>
      <Field label="Remarks"><textarea className="input" rows={2} value={v.remarks} onChange={set('remarks')} /></Field>
    </FormModal>
  );
}

function TextModal({ open, title, label, submitLabel, required, onClose, onSubmit }: { open: boolean; title: string; label: string; submitLabel: string; required: boolean; onClose: () => void; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return (
    <FormModal open={open} onClose={() => { setText(''); onClose(); }} title={title} submitLabel={submitLabel} onSubmit={async () => { await onSubmit(text.trim()); setText(''); }}>
      <Field label={label} required={required}><textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} required={required} /></Field>
    </FormModal>
  );
}
