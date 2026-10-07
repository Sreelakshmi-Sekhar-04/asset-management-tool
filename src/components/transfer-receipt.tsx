'use client';
import Link from 'next/link';
import { useState } from 'react';
import { RECEIPT_CONDITION_LABEL } from '@/lib/asset-status';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { api, useApi } from './api';
import { LineStatus, ReceiptCondition, TransferStatus } from './badges';
import { useMe } from './me';
import { Badge, Card, Field, FormModal, useToast } from './ui';

export interface ShipmentLine {
  id: string; assetId: string; assetCode: string; name: string; serialNumber: string | null; status: string; condition: string | null; remark: string | null;
  receivedAt: string | null; receivedByName: string | null; open: boolean;
  exception: { status: string; reason: string; resolution: string | null; resolutionNote: string | null } | null;
}
export interface Shipment {
  id: string; transferNo: string; status: string; approvalRequestId: string; from: string; to: string; effectiveDate: string;
  requestedByName: string; requestedAt: string; approvedAt: string | null; approverNames: string | null; completedAt: string | null;
  canReceive: boolean; canClose: boolean; lines: ShipmentLine[];
  receipts: { id: string; receivedByName: string; receivedAt: string; recordedBy: string; recordedAt: string; remarks: string | null }[];
}

const short = (p: string) => p.split(' / ').pop();
/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** Where an approved transfer stands after approval: in transit, received (and in what condition), or not received. */
export function TransferShipments({ requestId, onChanged }: { requestId: string; onChanged?: () => void }) {
  const { data, reload } = useApi<Shipment[]>(`/api/approvals/${requestId}/shipments`);
  const [receiving, setReceiving] = useState<Shipment | null>(null);
  const [closing, setClosing] = useState<{ s: Shipment; line: ShipmentLine } | null>(null);
  const toast = useToast();
  const [note, setNote] = useState('');
  if (!data?.length) return null;
  const changed = () => { reload(); onChanged?.(); };
  return (
    <>
      {data.map((s) => (
        <Card key={s.id} title={<span className="flex flex-wrap items-center gap-2">Receipt at destination · {s.transferNo} <TransferStatus s={s.status} /></span>}
          actions={s.canReceive && <button className="btn btn-sm btn-primary" onClick={() => setReceiving(s)}>Confirm receipt</button>}>
          <p className="mb-3 text-sm text-slate-600">
            {s.status === 'IN_TRANSIT' && <>Both approvals were given{s.approverNames ? ` (${s.approverNames})` : ''} on {fmtDateTime(s.approvedAt)}. The assets stay at {short(s.from)} until {short(s.to)} confirms what actually arrived and its condition.</>}
            {s.status === 'PARTIALLY_RECEIVED' && <>Some assets were reported not received. They stay at {short(s.from)} until they arrive (confirm receipt again) or an Administrator closes the exception.</>}
            {s.status === 'COMPLETED' && <>Completed {fmtDateTime(s.completedAt)}: every asset was received at {short(s.to)}.</>}
            {s.status === 'CANCELLED' && <>Closed: nothing arrived; the assets stayed at {short(s.from)}.</>}
          </p>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Asset ID</th><th>Asset name</th><th>Serial no.</th><th>From</th><th>To</th><th>Transfer date</th><th>Status</th><th>Condition</th><th>Received</th><th>Remarks</th>{s.canClose && <th />}</tr></thead>
              <tbody>{s.lines.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/assets/${l.assetId}`} className="font-semibold">{l.assetCode}</Link></td>
                  <td>{l.name}</td>
                  <td className="font-mono text-xs">{l.serialNumber ?? '—'}</td>
                  <td className="text-xs">{short(s.from)}</td>
                  <td className="text-xs">{short(s.to)}</td>
                  <td className="whitespace-nowrap text-xs">{fmtDateOnly(s.effectiveDate)}</td>
                  <td><LineStatus s={l.status} />{l.exception && <span className="mt-1 block text-[11px] text-slate-500">Exception {l.exception.status.toLowerCase()}{l.exception.resolutionNote ? `: ${l.exception.resolutionNote}` : ''}</span>}</td>
                  <td>{l.condition ? <ReceiptCondition c={l.condition} /> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="whitespace-nowrap text-xs">{l.receivedAt ? <>{fmtDateTime(l.receivedAt)}<br />by {l.receivedByName}</> : '—'}</td>
                  <td className="max-w-[16rem] text-xs">{l.remark ?? '—'}</td>
                  {s.canClose && <td>{l.exception?.status === 'OPEN' && <button className="btn btn-sm" onClick={() => { setClosing({ s, line: l }); setNote(''); }}>Close: stayed at source</button>}</td>}
                </tr>
              ))}</tbody>
            </table>
          </div>
          {s.receipts.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-slate-600">
              {s.receipts.map((r) => <li key={r.id}>Receipt recorded {fmtDateTime(r.recordedAt)} by {r.recordedBy}: received {fmtDateTime(r.receivedAt)} by {r.receivedByName}{r.remarks ? ` · ${r.remarks}` : ''}</li>)}
            </ul>
          )}
        </Card>
      ))}
      {receiving && <ReceiveDialog shipment={receiving} onClose={() => setReceiving(null)} onDone={changed} />}
      <FormModal open={!!closing} onClose={() => setClosing(null)} title={`Close the exception for ${closing?.line.assetCode ?? ''}`} submitLabel="Close exception" disabled={!note.trim()}
        onSubmit={async () => { await api(`/api/transfers/lines/${closing!.line.id}/close`, { body: { note } }); toast(`${closing!.line.assetCode} stays at ${short(closing!.s.from)}; exception closed`); changed(); }}>
        <p className="text-sm text-slate-600">Use this when the asset was found at {short(closing?.s.from ?? '')} and never left. It stays there, and the transfer is closed for it.</p>
        <Field label="What was found" required><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} required /></Field>
      </FormModal>
    </>
  );
}

type LineInput = { condition: string; remarks: string };

/** The destination records what arrived: when, who received it, and each asset's condition. */
export function ReceiveDialog({ shipment: s, onClose, onDone }: { shipment: Shipment; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const toast = useToast();
  const open = s.lines.filter((l) => l.open);
  const [receivedAt, setReceivedAt] = useState(nowLocal());
  const [receivedBy, setReceivedBy] = useState(me.name ?? '');
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Record<string, LineInput>>(() => Object.fromEntries(open.map((l) => [l.id, { condition: l.status === 'NOT_RECEIVED' ? '' : 'GOOD', remarks: '' }])));
  const set = (id: string, v: Partial<LineInput>) => setLines((x) => ({ ...x, [id]: { ...x[id], ...v } }));
  const needRemarks = (c: string) => !!c && c !== 'GOOD';
  const incomplete = open.some((l) => (l.status === 'IN_TRANSIT' && !lines[l.id]?.condition) || (needRemarks(lines[l.id]?.condition) && !lines[l.id].remarks.trim()));
  return (
    <FormModal open onClose={onClose} wide title={`Confirm receipt · ${s.transferNo}`} submitLabel="Complete receipt" disabled={incomplete || !receivedBy.trim() || !open.some((l) => lines[l.id]?.condition)}
      onSubmit={async () => {
        const body = {
          receivedAt: new Date(receivedAt).toISOString(), receivedByName: receivedBy, remarks: remarks || null,
          lines: open.filter((l) => lines[l.id]?.condition).map((l) => ({ lineId: l.id, condition: lines[l.id].condition, remarks: lines[l.id].remarks || null })),
        };
        const r = await api<{ status: string; received: number; notReceived: number }>(`/api/transfers/${s.id}/receive`, { body });
        toast(r.notReceived ? `${r.received} received, ${r.notReceived} not received: kept as a transfer exception` : `Receipt recorded: ${s.transferNo} is complete`, r.notReceived ? 'err' : 'ok');
        onDone();
      }}>
      <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div><span className="text-slate-500">From</span> {s.from}</div>
        <div><span className="text-slate-500">To</span> {s.to}</div>
        <div><span className="text-slate-500">Transfer date</span> {fmtDateOnly(s.effectiveDate)}</div>
        <div><span className="text-slate-500">Approved</span> {fmtDateTime(s.approvedAt)}{s.approverNames ? ` by ${s.approverNames}` : ''}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Received on (date and time)" required><input type="datetime-local" className="input" value={receivedAt} max={nowLocal()} onChange={(e) => setReceivedAt(e.target.value)} required /></Field>
        <Field label="Received by" required><input className="input" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} required /></Field>
      </div>
      <div className="space-y-2">
        {open.map((l) => (
          <div key={l.id} className="rounded-md border border-slate-200 p-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-sm">
              <b className="font-mono">{l.assetCode}</b><span>{l.name}</span><span className="font-mono text-xs text-slate-500">S/N {l.serialNumber ?? '—'}</span>
              {l.status === 'NOT_RECEIVED' && <Badge tone="red">Reported not received</Badge>}
            </div>
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <Field label="Actual condition" required={l.status === 'IN_TRANSIT'}>
                <select className="input" aria-label={`Condition of ${l.assetCode}`} value={lines[l.id]?.condition ?? ''} onChange={(e) => set(l.id, { condition: e.target.value })}>
                  {l.status === 'NOT_RECEIVED' && <option value="">Still not received</option>}
                  {Object.entries(RECEIPT_CONDITION_LABEL).filter(([k]) => l.status === 'IN_TRANSIT' || k !== 'NOT_RECEIVED').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label={needRemarks(lines[l.id]?.condition) ? 'Remarks / discrepancy (required)' : 'Remarks'} required={needRemarks(lines[l.id]?.condition)}>
                <input className="input" aria-label={`Remarks for ${l.assetCode}`} value={lines[l.id]?.remarks ?? ''} onChange={(e) => set(l.id, { remarks: e.target.value })}
                  placeholder={lines[l.id]?.condition === 'NOT_RECEIVED' ? 'What happened, e.g. not in the delivery' : needRemarks(lines[l.id]?.condition) ? 'e.g. Screen has a minor crack from transport' : 'Optional'} />
              </Field>
            </div>
          </div>
        ))}
      </div>
      <Field label="Notes for the whole delivery"><textarea className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
      <p className="text-xs text-slate-500">Received assets move to {short(s.to)} with the condition you record. An asset marked Not received stays at {short(s.from)} as a transfer exception; the transfer is not completed.</p>
    </FormModal>
  );
}

const MAIL_TONE: Record<string, string> = { PENDING: 'amber', SENT: 'green', FAILED: 'red' };

/** The emails this request sent and what really happened to each: queued, sent, or failed with the error. */
export function EmailDeliveries({ requestId }: { requestId: string }) {
  const { data } = useApi<{ id: string; to: string; subject: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null }[]>(`/api/approvals/${requestId}/emails`);
  if (!data?.length) return null;
  return (
    <Card title="Email notifications">
      <ul className="space-y-2 text-sm">
        {data.map((m) => (
          <li key={m.id} className="flex flex-wrap items-start justify-between gap-2">
            <span><span className="font-medium">{m.to}</span><span className="block text-xs text-slate-500">{m.subject}</span></span>
            <span className="text-right text-xs">
              <Badge tone={MAIL_TONE[m.status]}>{m.status === 'PENDING' ? (m.attempts ? 'Retrying' : 'Queued') : m.status === 'SENT' ? 'Sent' : 'Not sent'}</Badge>
              <span className="block text-slate-500">{m.status === 'SENT' ? fmtDateTime(m.sentAt) : m.lastError ?? `queued ${fmtDateTime(m.createdAt)}`}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
