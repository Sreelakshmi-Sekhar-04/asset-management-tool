'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { fmtDateOnly, fmtDateTime, fmtINR } from '@/lib/format';
import { label, RENEWABLE_TYPE_LABEL } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { DaysBadge } from '@/components/badges';
import { DocumentsPanel } from '@/components/documents';
import { useMe } from '@/components/me';
import { RenewableFormModal, type RenewableValues } from '@/components/renewable-form';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useToast } from '@/components/ui';

interface R {
  id: string; type: string; label: string; vendor: string | null; identifier: string | null; seats: number | null; startDate: string | null; expiryDate: string; renewalTermMonths: number | null; cost: string | null;
  ownerUserId: string | null; ownerEmployeeId: string | null; critical: boolean; status: string; source: string; sourceKey: string | null; cycle: number; acknowledgedAt: string | null; snoozedUntil: string | null; daysRemaining: number;
  asset: { id: string; assetCode: string; make: string; model: string; status: string; location: { namePath: string } | null };
  events: { id: string; action: string; oldExpiry: string | null; newExpiry: string | null; cost: string | null; note: string | null; createdAt: string }[];
  reminders: { id: string; cycle: number; tier: string; sentAt: string }[];
}
interface Doc { id: string; fileName: string }

const tierLabel = (t: string) => t === 'ESCALATION' ? 'Escalation' : t.startsWith('SNOOZE:') ? `After snooze (${t.slice(7)})` : t.startsWith('SKIPPED:') ? `${t.slice(8)}-day (skipped, created late)` : `${t}-day reminder`;

export default function RenewablePage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { data: r, error, reload } = useApi<R>(`/api/renewables/${id}`);
  const docs = useApi<{ rows: Doc[] }>(`/api/documents?entityType=RENEWABLE&entityId=${id}&pageSize=500`);
  const [dlg, setDlg] = useState<'' | 'edit' | 'renew' | 'ack' | 'snooze' | 'cancel'>('');
  const [f, setF] = useState({ newExpiry: '', cost: '', proof: '', note: '', until: '', reason: '' });
  const initial = useMemo<RenewableValues | undefined>(() => r ? {
    type: r.type, label: r.label, vendor: r.vendor ?? '', identifier: r.identifier ?? '', seats: r.seats?.toString() ?? '', startDate: r.startDate?.slice(0, 10) ?? '', expiryDate: r.expiryDate.slice(0, 10),
    renewalTermMonths: r.renewalTermMonths?.toString() ?? '', cost: r.cost ?? '', ownerUserId: r.ownerUserId ?? '', ownerEmployee: r.ownerEmployeeId ? { id: r.ownerEmployeeId, label: 'Current owner' } : null, critical: r.critical,
  } : undefined, [r]);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <div className="flex justify-center py-20"><Spinner /></div>;
  const open = (d: typeof dlg) => { setF({ newExpiry: '', cost: '', proof: '', note: '', until: '', reason: '' }); setDlg(d); };
  const done = (msg: string) => { toast(msg); reload(); };
  const editable = me.isIT && r.status !== 'CANCELLED' && r.asset.status !== 'RETIRED';
  const warrantyDriven = r.type === 'WARRANTY' && r.source === 'asset-warranty';
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/renewals', label: 'Renewals' }} title={r.label}
        subtitle={<span className="flex flex-wrap items-center gap-2">{label(RENEWABLE_TYPE_LABEL, r.type)} · <Link href={`/assets/${r.asset.id}`}>{r.asset.assetCode}</Link> {r.asset.make} {r.asset.model}{r.critical && <Badge tone="red">Critical</Badge>}{r.status === 'CANCELLED' && <Badge>Cancelled</Badge>}</span>}
        actions={editable && <>
          <button className="btn btn-primary" onClick={() => open('renew')}>Mark renewed</button>
          <button className="btn" onClick={() => open('ack')} disabled={!!r.acknowledgedAt}>{r.acknowledgedAt ? 'Acknowledged' : 'Acknowledge'}</button>
          <button className="btn" onClick={() => open('snooze')}>Snooze</button>
          {!warrantyDriven && <button className="btn" onClick={() => setDlg('edit')}>Edit</button>}
          {!warrantyDriven && <button className="btn btn-ghost text-red-600" onClick={() => open('cancel')}>Cancel renewable</button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="kv">
            <dt>Expiry</dt><dd>{fmtDateOnly(r.expiryDate)} {r.status !== 'CANCELLED' && <DaysBadge days={r.daysRemaining} />}</dd>
            <dt>Start</dt><dd>{fmtDateOnly(r.startDate)}</dd>
            <dt>Vendor</dt><dd>{r.vendor ?? '—'}</dd>
            <dt>Key / contract</dt><dd className="break-all">{r.identifier ?? '—'}</dd>
            <dt>Seats</dt><dd>{r.seats ?? '—'}</dd>
            <dt>Renewal term</dt><dd>{r.renewalTermMonths ? `${r.renewalTermMonths} months` : '—'}</dd>
            <dt>Cost</dt><dd>{r.cost ? fmtINR(Number(r.cost)) : '—'}</dd>
            <dt>Location</dt><dd>{r.asset.location?.namePath ?? '—'}</dd>
            <dt>Source</dt><dd>{warrantyDriven ? 'Asset warranty end date (edit the asset to change it)' : r.source}</dd>
            <dt>Cycle</dt><dd>{r.cycle}</dd>
            <dt>Reminders</dt><dd>{r.acknowledgedAt ? `Acknowledged ${fmtDateTime(r.acknowledgedAt)} (no escalation this cycle)` : r.snoozedUntil ? `Snoozed until ${fmtDateOnly(r.snoozedUntil)}` : 'Active'}</dd>
          </dl>
        </Card>
        <Card title="Reminders sent">
          {r.reminders.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
            <ul className="space-y-1 text-sm">{r.reminders.map((x) => <li key={x.id}>{tierLabel(x.tier)} <span className="text-xs text-slate-500">· cycle {x.cycle} · {fmtDateTime(x.sentAt)}</span></li>)}</ul>
          )}
        </Card>
      </div>
      <Card title="Renewal history">
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>When</th><th>Action</th><th>Old expiry</th><th>New expiry</th><th>Cost</th><th>Note</th></tr></thead>
          <tbody>{r.events.map((e) => <tr key={e.id}><td className="whitespace-nowrap">{fmtDateTime(e.createdAt)}</td><td>{e.action.toLowerCase().replace(/_/g, ' ')}</td><td>{fmtDateOnly(e.oldExpiry)}</td><td>{fmtDateOnly(e.newExpiry)}</td><td>{e.cost ? fmtINR(Number(e.cost)) : ''}</td><td className="text-xs">{e.note}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <DocumentsPanel entityType="RENEWABLE" entityId={r.id} canUpload={me.isIT} isAdmin={me.isAdmin} title="Documents (invoices, renewal proof)" />

      <RenewableFormModal open={dlg === 'edit'} id={r.id} initial={initial} onClose={() => setDlg('')} onSaved={() => done('Saved')} />
      <FormModal open={dlg === 'renew'} onClose={() => setDlg('')} title="Mark renewed" submitLabel="Mark renewed"
        onSubmit={async () => { await api(`/api/renewables/${id}/renew`, { body: { newExpiry: f.newExpiry, cost: f.cost ? Number(f.cost) : null, proofDocumentId: f.proof || null, note: f.note || undefined } }); docs.reload(); done('Renewed; reminders restart for the new cycle'); }}>
        <p className="text-xs text-slate-500">Current expiry {fmtDateOnly(r.expiryDate)}. Upload the renewal invoice in Documents first if you want to link it as proof.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New expiry" required><input className="input" type="date" required value={f.newExpiry} onChange={(e) => setF({ ...f, newExpiry: e.target.value })} /></Field>
          <Field label="Renewal cost (₹)"><input className="input" type="number" min={0} step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
        </div>
        <Field label="Proof document"><select className="input" value={f.proof} onChange={(e) => setF({ ...f, proof: e.target.value })}><option value="">None</option>{(docs.data?.rows ?? []).map((d) => <option key={d.id} value={d.id}>{d.fileName}</option>)}</select></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </FormModal>
      <FormModal open={dlg === 'ack'} onClose={() => setDlg('')} title="Acknowledge reminder" submitLabel="Acknowledge"
        onSubmit={async () => { await api(`/api/renewables/${id}/acknowledge`, { body: { note: f.note || undefined } }); done('Acknowledged'); }}>
        <p className="text-sm text-slate-600">Acknowledging records that someone is handling this renewal and stops escalation for the current cycle.</p>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </FormModal>
      <FormModal open={dlg === 'snooze'} onClose={() => setDlg('')} title="Snooze reminders" submitLabel="Snooze"
        onSubmit={async () => { await api(`/api/renewables/${id}/snooze`, { body: { until: f.until, note: f.note || undefined } }); done('Snoozed'); }}>
        <Field label="Remind me again on" required><input className="input" type="date" required value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </FormModal>
      <FormModal open={dlg === 'cancel'} onClose={() => setDlg('')} title="Cancel renewable" submitLabel="Cancel renewable" danger
        onSubmit={async () => { await api(`/api/renewables/${id}/cancel`, { body: { reason: f.reason } }); done('Cancelled'); }}>
        <p className="text-sm text-slate-600">No further reminders are sent. The record and its history are kept.</p>
        <Field label="Reason" required><input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </FormModal>
    </div>
  );
}
