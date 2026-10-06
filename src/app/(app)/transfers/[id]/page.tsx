'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { api, download, qs, useApi } from '@/components/api';
import { ApprovalChain, type ApprovalReq } from '@/components/approval-chain';
import { LineStatus, TransferStatus } from '@/components/badges';
import { DocumentsPanel } from '@/components/documents';
import { DataTable, FilterSelect } from '@/components/list';
import { useMe } from '@/components/me';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, Tabs, useConfirm, useToast } from '@/components/ui';
import { DEFAULT_PAGE_SIZE } from '@/lib/paging';

interface Tr {
  id: string; transferNo: string; status: string; reason: string; remarks: string | null; interState: boolean; recordedLate: boolean; requestedByName: string; requestedAt: string; submittedAt: string | null; effectiveDate: string;
  linkedReference: string | null; sdpTicketId: string | null; sdpTicketUrl: string | null; invoiceNumber: string | null; autoApproved: boolean; approvedAt: string | null; approverNames: string | null; approvalComment: string | null;
  rejectedAt: string | null; cancelledAt: string | null; completedAt: string | null; resendOfExceptionIds: string[];
  fromLocation: { id: string; namePath: string }; toLocation: { id: string; namePath: string };
  receipts: { id: string; actorName: string; receivedByName: string; remarks: string | null; createdAt: string }[];
  counts: { total: number; received: number; rejected: number; recalled: number; pending: number; resolved: number }; progress: string;
  approval: ApprovalReq | null; exceptions: { id: string; status: string; reason: string; resolution: string | null }[];
  permissions: { canApprove: boolean; canCancel: boolean; canSubmit: boolean; canRecall: boolean; canReceive: boolean; isReceiver: boolean };
}
interface Line { id: string; assetId: string; assetCode: string; serialNumber: string | null; make: string | null; model: string | null; status: string; receivedByName: string | null; rejectReason: string | null; remark: string | null; resolvedAt: string | null; exception: { id: string; status: string; resolution: string | null } | null }

export default function TransferDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { confirm, node: confirmNode } = useConfirm();
  const { data: t, error, reload } = useApi<Tr>(`/api/transfers/${id}`);
  const [tab, setTab] = useState('lines');
  const [lineStatus, setLineStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data: lines, loading: linesLoading, reload: reloadLines } = useApi<{ rows: Line[]; total: number }>(t ? `/api/transfers/${t.id}/lines${qs({ status: lineStatus, page, pageSize })}` : null, [t?.status]);
  const [receiving, setReceiving] = useState(false);
  const [decision, setDecision] = useState<'' | 'APPROVE' | 'REJECT'>('');
  const [comment, setComment] = useState('');
  const [recall, setRecall] = useState(false);
  const [recallReason, setRecallReason] = useState('');
  if (error) return <ErrorBox error={error} />;
  if (!t) return <div className="flex justify-center py-20"><Spinner /></div>;
  const refresh = () => { reload(); reloadLines(); };
  const act = async (path: string, msg: string, question?: string) => {
    if (question && !(await confirm(question))) return;
    try { await api(`/api/transfers/${t.id}/${path}`, { method: 'POST' }); toast(msg); refresh(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="space-y-4">
      {confirmNode}
      <PageHeader back={{ href: '/transfers', label: 'Transfer register' }}
        title={<span className="flex flex-wrap items-center gap-2">{t.transferNo} <TransferStatus s={t.status} />{t.interState && <Badge tone="purple">Inter-state</Badge>}{t.recordedLate && <Badge tone="amber">Recorded late</Badge>}</span>}
        subtitle={<>{t.fromLocation.namePath} → {t.toLocation.namePath} · <b>{t.progress}</b></>}
        actions={<>
          {t.permissions.canApprove && <><button className="btn btn-primary" onClick={() => { setDecision('APPROVE'); setComment(''); }}>Approve</button><button className="btn btn-danger" onClick={() => { setDecision('REJECT'); setComment(''); }}>Reject</button></>}
          {t.permissions.canReceive && <button className="btn btn-primary" onClick={() => { setReceiving(true); setTab('lines'); setLineStatus('IN_TRANSIT'); }}>Receive</button>}
          {t.permissions.canSubmit && <button className="btn btn-primary" onClick={() => act('submit', 'Submitted')}>Submit</button>}
          {t.permissions.canCancel && <button className="btn" onClick={() => act('cancel', 'Cancelled', `Cancel ${t.transferNo}? Its assets are released.`)}>Cancel transfer</button>}
          {t.permissions.canRecall && <button className="btn" onClick={() => { setRecall(true); setRecallReason(''); }}>Recall</button>}
          <button className="btn" onClick={() => download(`/api/transfers/${t.id}/note`).catch((e) => toast(e.message, 'err'))}>Transfer note (PDF)</button>
        </>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="kv">
            <dt>Reason</dt><dd>{t.reason}</dd>
            {t.remarks && <><dt>Remarks</dt><dd>{t.remarks}</dd></>}
            <dt>Requested</dt><dd>{t.requestedByName} · {fmtDateTime(t.requestedAt)}</dd>
            <dt>Effective date</dt><dd>{fmtDateOnly(t.effectiveDate)}{t.recordedLate && ' (recorded late)'}</dd>
            <dt>Approval</dt><dd>{t.approvedAt ? `${t.autoApproved ? 'Auto-approved' : `Approved by ${t.approverNames}`} · ${fmtDateTime(t.approvedAt)}` : t.rejectedAt ? `Rejected ${fmtDateTime(t.rejectedAt)}${t.approvalComment ? `: “${t.approvalComment}”` : ''}` : t.status === 'PENDING_APPROVAL' ? 'Awaiting approval' : '—'}</dd>
            {t.completedAt && <><dt>Completed</dt><dd>{fmtDateTime(t.completedAt)}</dd></>}
            {t.cancelledAt && <><dt>Cancelled</dt><dd>{fmtDateTime(t.cancelledAt)}</dd></>}
            {t.linkedReference && <><dt>Linked reference</dt><dd>{t.linkedReference}</dd></>}
            {(t.sdpTicketId || t.sdpTicketUrl) && <><dt>SDP ticket</dt><dd>{t.sdpTicketUrl ? <a href={t.sdpTicketUrl} target="_blank" rel="noopener noreferrer">{t.sdpTicketId ?? t.sdpTicketUrl}</a> : t.sdpTicketId}</dd></>}
            {t.interState && <><dt>Invoice number</dt><dd>{t.invoiceNumber ?? '—'}</dd></>}
            {t.resendOfExceptionIds.length > 0 && <><dt>Re-send of</dt><dd>{t.resendOfExceptionIds.length} exception(s)</dd></>}
          </dl>
        </Card>
        <Card title="Line summary">
          <dl className="kv">
            <dt>Sent</dt><dd>{t.counts.total}</dd>
            <dt>Received</dt><dd>{t.counts.received}</dd>
            <dt>Not received</dt><dd className={t.counts.rejected ? 'text-red-600' : ''}>{t.counts.rejected}</dd>
            <dt>Recalled</dt><dd>{t.counts.recalled}</dd>
            <dt>Outstanding</dt><dd>{t.counts.pending}</dd>
          </dl>
          {t.approval && <div className="mt-3"><div className="mb-1 text-xs font-medium text-slate-500">Approval {t.approval.requestNo} · {t.approval.policyName}</div><ApprovalChain req={t.approval} /></div>}
        </Card>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'lines', label: `Lines (${t.counts.total})` }, { key: 'receipts', label: `Receipts (${t.receipts.length})` }, { key: 'documents', label: 'Documents' }]} />
      {tab === 'lines' && (receiving
        ? <ReceivePanel t={t} onDone={() => { setReceiving(false); setLineStatus(''); refresh(); }} onCancel={() => setReceiving(false)} />
        : (
          <div>
            <div className="mb-2"><FilterSelect label="Line status" value={lineStatus} onChange={(v) => { setLineStatus(v); setPage(1); }} options={['IN_TRANSIT', 'RECEIVED', 'NOT_RECEIVED', 'RECALLED', 'PENDING_APPROVAL', 'DRAFT', 'CANCELLED'].map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() }))} /></div>
            <DataTable rows={lines?.rows ?? []} total={lines?.total ?? 0} loading={linesLoading} page={page} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }}
              columns={[
                { key: 'assetCode', header: 'Asset ID', render: (l) => <Link href={`/assets/${l.assetId}`}>{l.assetCode}</Link> },
                { key: 'serialNumber', header: 'Serial', render: (l) => l.serialNumber ?? '—' },
                { key: 'item', header: 'Make / model', render: (l) => `${l.make ?? ''} ${l.model ?? ''}` },
                { key: 'status', header: 'Status', render: (l) => <span className="flex flex-col items-start gap-1"><LineStatus s={l.status} />{l.exception && <Badge tone={l.exception.status === 'OPEN' ? 'red' : 'gray'}>Exception {l.exception.status === 'OPEN' ? 'open' : l.exception.resolution?.toLowerCase().replace(/_/g, ' ')}</Badge>}</span> },
                { key: 'recv', header: 'Received by / reason', render: (l) => <span className="text-xs">{l.status === 'NOT_RECEIVED' ? l.rejectReason : l.receivedByName ?? '—'}{l.remark && <span className="block text-slate-500">{l.remark}</span>}</span> },
                { key: 'resolvedAt', header: 'Resolved', render: (l) => fmtDateTime(l.resolvedAt) },
              ]} />
          </div>
        ))}
      {tab === 'receipts' && (
        <Card title="Receipts">
          {t.receipts.length === 0 ? <p className="text-sm text-slate-500">Nothing received yet.</p> : (
            <ul className="divide-y text-sm">{t.receipts.map((r) => <li key={r.id} className="py-2"><b>{r.receivedByName}</b> (recorded by {r.actorName}) · {fmtDateTime(r.createdAt)}{r.remarks && <div className="text-xs text-slate-600">{r.remarks}</div>}<div className="mt-1"><DocumentsPanel entityType="TRANSFER_RECEIPT" entityId={r.id} title="Receipt evidence" canUpload={t.permissions.isReceiver} isAdmin={me.isAdmin} /></div></li>)}</ul>
          )}
        </Card>
      )}
      {tab === 'documents' && <DocumentsPanel entityType="TRANSFER" entityId={t.id} isAdmin={me.isAdmin} />}

      <FormModal open={!!decision} onClose={() => setDecision('')} title={`${decision === 'APPROVE' ? 'Approve' : 'Reject'} ${t.transferNo}`} submitLabel={decision === 'APPROVE' ? 'Approve' : 'Reject'} danger={decision === 'REJECT'}
        onSubmit={async () => { await api(`/api/approvals/${t.approval!.id}/decide`, { body: { decision, comment: comment || null } }); toast(decision === 'APPROVE' ? 'Approved' : 'Rejected'); refresh(); }}>
        <Field label={decision === 'REJECT' ? 'Reason (required)' : 'Comment (optional)'} required={decision === 'REJECT'}><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} required={decision === 'REJECT'} /></Field>
      </FormModal>
      <FormModal open={recall} onClose={() => setRecall(false)} title={`Recall ${t.transferNo}`} submitLabel="Recall outstanding lines"
        onSubmit={async () => { await api(`/api/transfers/${t.id}/recall`, { body: { reason: recallReason } }); toast('Recalled'); refresh(); }}>
        <p className="text-sm text-slate-600">All {t.counts.pending} outstanding line(s) are recalled: the assets stay at {t.fromLocation.namePath} and are released. Lines already received are unaffected.</p>
        <Field label="Reason" required><textarea className="input" value={recallReason} onChange={(e) => setRecallReason(e.target.value)} required /></Field>
      </FormModal>
    </div>
  );
}

function ReceivePanel({ t, onDone, onCancel }: { t: Tr; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const { data, loading } = useApi<{ rows: Line[]; total: number }>(`/api/transfers/${t.id}/lines?status=IN_TRANSIT&pageSize=500`);
  const [outcome, setOutcome] = useState<Record<string, { o: 'RECEIVED' | 'NOT_RECEIVED' | ''; reason: string }>>({});
  const [receivedBy, setReceivedBy] = useState('');
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rows = data?.rows ?? [];
  const marked = rows.filter((l) => outcome[l.id]?.o);
  const submit = async (all: boolean) => {
    setBusy(true); setErr(null);
    try {
      const body = all ? { receivedByName: receivedBy, remarks: remarks || null, all: 'RECEIVED' }
        : { receivedByName: receivedBy, remarks: remarks || null, lines: marked.map((l) => ({ lineId: l.id, outcome: outcome[l.id].o, reason: outcome[l.id].reason || null })) };
      const r = await api<{ progress?: string }>(`/api/transfers/${t.id}/receive`, { body });
      toast(r.progress ?? 'Receipt recorded');
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Record receipt" actions={<button className="btn btn-sm" onClick={onCancel}>Close</button>}>
      <p className="mb-3 text-sm text-slate-600">Mark what physically arrived. You can receive part now and the rest later. “Not received” needs a reason and raises an exception for IT.</p>
      {loading ? <Spinner /> : (
        <>
          {data && data.total > rows.length && <p className="mb-2 text-xs text-amber-700">Showing the first {rows.length} of {data.total} outstanding lines. Use “Receive all” for the full set, or record in batches.</p>}
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            <button className="btn btn-sm" onClick={() => setOutcome(Object.fromEntries(rows.map((l) => [l.id, { o: 'RECEIVED', reason: '' }])))}>Mark all shown as received</button>
            <button className="btn btn-sm" onClick={() => setOutcome({})}>Clear marks</button>
          </div>
          <div className="max-h-[50vh] overflow-auto rounded border">
            <table className="tbl">
              <thead><tr><th>Asset ID</th><th>Serial</th><th>Item</th><th>Outcome</th><th>Reason if not received</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td className="font-medium">{l.assetCode}</td><td>{l.serialNumber ?? '—'}</td><td>{l.make} {l.model}</td>
                    <td className="whitespace-nowrap">
                      <label className="mr-3"><input type="radio" name={l.id} checked={outcome[l.id]?.o === 'RECEIVED'} onChange={() => setOutcome((x) => ({ ...x, [l.id]: { o: 'RECEIVED', reason: '' } }))} /> Received</label>
                      <label><input type="radio" name={l.id} checked={outcome[l.id]?.o === 'NOT_RECEIVED'} onChange={() => setOutcome((x) => ({ ...x, [l.id]: { o: 'NOT_RECEIVED', reason: x[l.id]?.reason ?? '' } }))} /> Not received</label>
                    </td>
                    <td>{outcome[l.id]?.o === 'NOT_RECEIVED' && <input className="input py-1" value={outcome[l.id].reason} onChange={(e) => setOutcome((x) => ({ ...x, [l.id]: { o: 'NOT_RECEIVED', reason: e.target.value } }))} placeholder="Required" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Received by (name)" required><input className="input" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} /></Field>
            <Field label="Remarks"><input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
          </div>
          <ErrorBox error={err} className="mt-3" />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button className="btn" disabled={busy || !receivedBy.trim()} onClick={() => submit(true)}>Receive all {data?.total ?? ''} outstanding</button>
            <button className="btn btn-primary" disabled={busy || !receivedBy.trim() || !marked.length} onClick={() => submit(false)}>{busy && <Spinner className="h-3 w-3" />}Record {marked.length} line(s)</button>
          </div>
        </>
      )}
    </Card>
  );
}
