'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Fragment, useState } from 'react';
import { daysBetween, fmtDateOnly, fmtDateTime, fmtINR, todayIST, dateOnly } from '@/lib/format';
import { HOLDER_TYPE_LABEL, label, RENEWABLE_TYPE_LABEL, STATUS_LABEL } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { AssetFields, DuplicateNotice, toPayload, type AssetFormValues } from '@/components/asset-form';
import { AssetStatus, DaysBadge, Flags } from '@/components/badges';
import { DocumentsPanel } from '@/components/documents';
import { AssetQrCard, PrintLabelsDialog } from '@/components/labels';
import { useMe } from '@/components/me';
import { HolderPicker, LocationSelect, type HolderValue } from '@/components/pickers';
import { BulkAssignDialog, bulkAssignMessage } from '@/components/bulk-assign';
import { DuplicateDetails, StatusCell, type DuplicateInfo, type TransferInfo } from '@/components/asset-list-parts';
import { Badge, Card, ErrorBox, Field, FormModal, Modal, PageHeader, Spinner, Tabs, useToast } from '@/components/ui';

interface Detail {
  id: string; assetCode: string; legacyTag: string | null; category: string; categoryId: string; make: string; model: string; serialNumber: string | null; hostname: string | null; ipAddress: string | null; macAddress: string | null;
  status: string; location: string | null; locationId: string; holderType: string | null; holder: string | null; warrantyEnd: string | null; purchaseCost: string | null; vendor: string | null; flags: string[];
  openTransfer: { id: string; transferNo: string; status: string; toLocation: string } | null; updatedAt: string; createdAt: string; retiredAt: string | null; disposalType: string | null; retireReason: string | null;
  raw: { purchaseDate: string | null; condition: string | null; remarks: string | null; sdpTicketId: string | null; sdpTicketUrl: string | null; origin: string; fieldSources: Record<string, string>; holderEmployeeId: string | null; holderDepartmentId: string | null; holderLocationId: string | null; categorySerialRequired: boolean; createdBy: string; updatedBy: string | null; retiredBy: string | null };
  renewables: { id: string; type: string; label: string; expiryDate: string; status: string; source: string | null; vendor: string | null }[];
  assignments: { id: string; holderType: string; holderName: string; startAt: string; endAt: string | null; source: string }[];
  duplicates: DuplicateInfo[];
  transferStatus: string; displayStatus: string; condition: string | null; transfer: TransferInfo | null;
  deviceData: { id: string; sourceKey: string; externalId: string | null; os: string | null; osVersion: string | null; lastSeen: string | null; currentUser: string | null; patchStatus: string | null; lastPatched: string | null; applications: unknown[]; updatedAt: string }[];
  exceptions: { id: string; reason: string; transferId: string; createdAt: string }[];
  pendingApprovals: { id: string; requestNo: string; action: string; summary: string }[];
}
interface TL { at: string; effectiveAt?: string | null; kind: string; title: string; actor: string | null; details: string[]; ref?: { type: string; id: string; label: string } }

type Dialog = '' | 'label' | 'edit' | 'assign' | 'checkin' | 'repair' | 'repairdone' | 'retire' | 'correct' | 'clear';

export default function AssetDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { data: a, error, reload } = useApi<Detail>(`/api/assets/${id}`);
  const [tab, setTab] = useState('overview');
  const [dlg, setDlg] = useState<Dialog>('');
  const sp = useSearchParams();
  const justRegistered = sp.get('registered') === '1';
  const scanned = sp.get('scanned') === '1';
  if (error) return <ErrorBox error={error} />;
  if (!a) return <div className="flex justify-center py-20"><Spinner /></div>;
  const retired = a.status === 'RETIRED';
  const locked = !!a.openTransfer || a.pendingApprovals.length > 0 || a.exceptions.length > 0;
  const done = (msg: string) => (r: unknown) => {
    const p = (r as { pendingApproval?: { requestNo: string; policy: string } })?.pendingApproval;
    toast(p ? `Sent for approval: ${p.requestNo} (${p.policy})` : msg);
    reload();
  };
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/assets', label: 'Asset register' }}
        title={<span className="flex flex-wrap items-center gap-2">{a.assetCode} <AssetStatus s={a.displayStatus} /> <Flags flags={a.flags} /></span>}
        subtitle={`${a.category} · ${a.make} ${a.model}${a.serialNumber ? ` · S/N ${a.serialNumber}` : ''}`}
        actions={<>
          {!retired && <button className="btn" onClick={() => setDlg('edit')}>Edit</button>}
          {me.isIT && !retired && !locked && (a.status === 'IN_STOCK' || a.status === 'ASSIGNED') && <button className="btn" onClick={() => setDlg('assign')}>Assign</button>}
          {me.isIT && !locked && a.status === 'ASSIGNED' && <button className="btn" onClick={() => setDlg('checkin')}>Check in</button>}
          {me.isIT && !locked && (a.status === 'IN_STOCK' || a.status === 'ASSIGNED') && <button className="btn" onClick={() => setDlg('repair')}>Send to repair</button>}
          {me.isIT && !locked && a.status === 'UNDER_REPAIR' && <button className="btn" onClick={() => setDlg('repairdone')}>Repair done</button>}
          {me.isIT && !locked && a.status === 'IN_STOCK' && <button className="btn" onClick={() => setDlg('retire')}>Retire</button>}
          <button className="btn" onClick={() => setDlg('label')}>Print label</button>
          {me.isAdmin && !retired && !locked && <button className="btn" onClick={() => setDlg('correct')}>Correct location / holder</button>}
          {me.isIT && a.flags.length > 0 && <button className="btn" onClick={() => setDlg('clear')}>Clear flag</button>}
        </>} />

      {justRegistered && <div className="flex flex-wrap items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm">Registered as <b className="font-mono">{a.assetCode}</b>. Print its label and attach it to the device.<button className="btn btn-sm btn-primary" onClick={() => setDlg('label')}>Print label</button></div>}
      {scanned && <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">Opened from a scan.<Link className="btn btn-sm" href="/scan">Scan next</Link></div>}
      {a.openTransfer && (
        <div className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-sm">
          Transfer {a.openTransfer.transferNo} to {a.openTransfer.toLocation} has both approvals and is waiting for the destination to confirm receipt. The asset stays at {a.location} until then.
          {a.transfer && <> <Link href={`/approvals/${a.transfer.id}`}>Open the transfer</Link></>}
        </div>
      )}
      {a.pendingApprovals.map((p) => <div key={p.id} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">Pending approval <Link href={`/approvals/${p.id}`}>{p.requestNo}</Link>: {p.summary}. The asset is locked until it is decided.</div>)}
      {a.exceptions.map((x) => <div key={x.id} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm">Not received at the destination: {x.reason}. The asset stays at {a.location} until the destination receives it late or an Administrator closes the exception{a.transfer && <> on <Link href={`/approvals/${a.transfer.id}`}>the transfer</Link></>}.</div>)}

      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'history', label: 'History' }, { key: 'renewables', label: `Renewables (${a.renewables.length})` }, { key: 'documents', label: 'Documents' }, ...(a.deviceData.length ? [{ key: 'device', label: 'Device data' }] : [])]} />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Where and who">
            <dl className="kv">
              <dt>Location</dt><dd>{a.location ?? '—'}</dd>
              <dt>Holder</dt><dd>{a.holder ? `${a.holder} (${label(HOLDER_TYPE_LABEL, a.holderType)})` : 'None'}</dd>
              <dt>Status</dt><dd><StatusCell r={{ ...a, flags: [] }} /></dd>
              {retired && <><dt>Retired</dt><dd>{fmtDateOnly(a.retiredAt)} by {a.raw.retiredBy ?? '—'} · {a.disposalType?.toLowerCase()} · {a.retireReason}</dd></>}
            </dl>
          </Card>
          <Card title="Identification">
            <dl className="kv">
              <dt>Asset ID</dt><dd className="font-mono">{a.assetCode}</dd>
              <dt>Legacy tag</dt><dd>{a.legacyTag ?? '—'}</dd>
              <dt>Serial</dt><dd>{a.serialNumber ?? '—'}{a.raw.fieldSources.serialNumber && a.raw.fieldSources.serialNumber !== 'manual' ? <Badge tone="teal">{a.raw.fieldSources.serialNumber}</Badge> : null}</dd>
              {(['hostname', 'ipAddress', 'macAddress'] as const).map((k) => (
                <Fragment key={k}>
                  <dt>{k === 'hostname' ? 'Hostname' : k === 'ipAddress' ? 'IP address' : 'MAC address'}</dt>
                  <dd>{a[k] ?? '—'} {a.raw.fieldSources[k] && !['manual', 'import'].includes(a.raw.fieldSources[k]) && <Badge tone="teal" title="Field source">{a.raw.fieldSources[k]}</Badge>}</dd>
                </Fragment>
              ))}
            </dl>
          </Card>
          <Card title="QR code and label">
            <AssetQrCard id={a.id} assetCode={a.assetCode} onPrint={() => setDlg('label')} />
          </Card>
          <Card title="Purchase and warranty">
            <dl className="kv">
              <dt>Purchase date</dt><dd>{fmtDateOnly(a.raw.purchaseDate)}</dd>
              <dt>Cost</dt><dd>{fmtINR(a.purchaseCost)}</dd>
              <dt>Vendor</dt><dd>{a.vendor ?? '—'}</dd>
              <dt>Warranty end</dt><dd>{a.warrantyEnd ? <>{fmtDateOnly(a.warrantyEnd)} <DaysBadge days={daysBetween(dateOnly(todayIST()), new Date(a.warrantyEnd))} /></> : '—'}</dd>
              <dt>Condition</dt><dd>{a.raw.condition ?? '—'}</dd>
            </dl>
          </Card>
          <Card title="Record">
            <dl className="kv">
              <dt>Remarks</dt><dd className="whitespace-pre-wrap">{a.raw.remarks ?? '—'}</dd>
              <dt>SDP ticket</dt><dd>{a.raw.sdpTicketUrl ? <a href={a.raw.sdpTicketUrl} target="_blank" rel="noopener noreferrer">{a.raw.sdpTicketId ?? a.raw.sdpTicketUrl}</a> : a.raw.sdpTicketId ?? '—'}</dd>
              <dt>Origin</dt><dd>{a.raw.origin}</dd>
              <dt>Created</dt><dd>{fmtDateTime(a.createdAt)} by {a.raw.createdBy}</dd>
              <dt>Last updated</dt><dd>{fmtDateTime(a.updatedAt)}{a.raw.updatedBy ? ` by ${a.raw.updatedBy}` : ''}</dd>
            </dl>
          </Card>
          {a.duplicates.length > 0 && (
            <Card title="Why this is a duplicate suspect" className="lg:col-span-2" bodyClass="p-0">
              <DuplicateDetails items={a.duplicates} />
            </Card>
          )}
          <Card title="Assignment history" className="lg:col-span-2">
            {a.assignments.length === 0 ? <p className="text-sm text-slate-500">Never assigned.</p> : (
              <table className="tbl"><thead><tr><th>Holder</th><th>Type</th><th>From</th><th>To</th><th>Source</th></tr></thead>
                <tbody>{a.assignments.map((x) => <tr key={x.id}><td>{x.holderName}</td><td>{label(HOLDER_TYPE_LABEL, x.holderType)}</td><td>{fmtDateTime(x.startAt)}</td><td>{x.endAt ? fmtDateTime(x.endAt) : <Badge tone="green">Current</Badge>}</td><td>{x.source}</td></tr>)}</tbody></table>
            )}
          </Card>
        </div>
      )}
      {tab === 'history' && <History id={a.id} />}
      {tab === 'renewables' && (
        <Card title="Renewables" actions={me.isIT && <Link className="btn btn-sm" href={`/renewals?new=${a.id}`}>Add renewable</Link>}>
          {a.renewables.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
            <table className="tbl"><thead><tr><th>Type</th><th>Item</th><th>Expires</th><th>Status</th><th>Source</th></tr></thead>
              <tbody>{a.renewables.map((r) => <tr key={r.id}><td>{label(RENEWABLE_TYPE_LABEL, r.type)}</td><td><Link href={`/renewals/${r.id}`}>{r.label}</Link></td><td>{fmtDateOnly(r.expiryDate)} <DaysBadge days={daysBetween(dateOnly(todayIST()), new Date(r.expiryDate))} /></td><td>{r.status}</td><td>{r.source ?? 'manual'}</td></tr>)}</tbody></table>
          )}
        </Card>
      )}
      {tab === 'documents' && <DocumentsPanel entityType="ASSET" entityId={a.id} isAdmin={me.isAdmin} canUpload={!retired || me.isAdmin} />}
      {tab === 'device' && (
        <div className="space-y-3">
          <div className="rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">Read-only data received from device-management sources. Patch information is shown for awareness only; this system does not perform, schedule or verify patching.</div>
          {a.deviceData.map((d) => (
            <Card key={d.id} title={`Source: ${d.sourceKey}`}>
              <dl className="kv">
                <dt>External ID</dt><dd>{d.externalId ?? '—'}</dd>
                <dt>OS</dt><dd>{[d.os, d.osVersion].filter(Boolean).join(' ') || '—'}</dd>
                <dt>Last seen</dt><dd>{fmtDateTime(d.lastSeen)}</dd>
                <dt>Current user</dt><dd>{d.currentUser ?? '—'}</dd>
                <dt>Patch status</dt><dd>{d.patchStatus ?? '—'}</dd>
                <dt>Last patched</dt><dd>{fmtDateOnly(d.lastPatched)}</dd>
                <dt>Applications</dt><dd>{(d.applications as (string | { name?: string })[]).map((x) => (typeof x === 'string' ? x : x.name ?? JSON.stringify(x))).join(', ') || '—'}</dd>
                <dt>Received</dt><dd>{fmtDateTime(d.updatedAt)}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}

      <PrintLabelsDialog open={dlg === 'label'} onClose={() => setDlg('')} assetIds={[a.id]} title={`Print label for ${a.assetCode}`} />
      <EditDialog open={dlg === 'edit'} onClose={() => setDlg('')} a={a} branchOnly={me.isBranch} onDone={done('Saved')} />
      <BulkAssignDialog open={dlg === 'assign'} onClose={() => setDlg('')} count={1} selection={() => ({ assetIds: [a.id] })}
        onDone={(r) => { toast(bulkAssignMessage(r)); reload(); }} />
      <SimpleDialog open={dlg === 'checkin'} onClose={() => setDlg('')} title={`Check in ${a.assetCode}`} submitLabel="Check in" fields={[{ k: 'condition', label: 'Condition' }, { k: 'remarks', label: 'Remarks', area: true }]} path={`/api/assets/${a.id}/check-in`} onDone={done('Checked in')} note={`Returns the asset from ${a.holder} to stock at ${a.location}.`} />
      <SimpleDialog open={dlg === 'repair'} onClose={() => setDlg('')} title={`Send ${a.assetCode} to repair`} submitLabel="Send to repair" fields={[{ k: 'reason', label: 'Reason', area: true, required: true }]} path={`/api/assets/${a.id}/repair`} onDone={done('Marked under repair')} note={a.holder ? `The holder (${a.holder}) is kept; the asset returns to them when the repair is done.` : undefined} />
      <SimpleDialog open={dlg === 'repairdone'} onClose={() => setDlg('')} title={`Complete repair of ${a.assetCode}`} submitLabel="Repair done" fields={[{ k: 'condition', label: 'Condition' }, { k: 'remarks', label: 'Remarks', area: true }]} path={`/api/assets/${a.id}/repair-done`} onDone={done('Repair completed')} />
      <RetireDialog open={dlg === 'retire'} onClose={() => setDlg('')} a={a} onDone={done('Retired')} />
      <CorrectDialog open={dlg === 'correct'} onClose={() => setDlg('')} a={a} onDone={done('Corrected')} />
      <ClearFlagDialog open={dlg === 'clear'} onClose={() => setDlg('')} a={a} onDone={done('Flag cleared')} />
    </div>
  );
}

function History({ id }: { id: string }) {
  const { data, loading, error } = useApi<TL[]>(`/api/assets/${id}/timeline`);
  const [date, setDate] = useState('');
  const [asOf, setAsOf] = useState<{ existed: boolean; location?: string; holder?: string | null; status?: string; inTransit?: { transferNo: string; to: string } | null; basedOn?: { kind: string; effectiveAt: string } } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Timeline" className="lg:col-span-2">
        <ErrorBox error={error} />
        {loading && <Spinner />}
        <ol className="relative space-y-3 border-l border-slate-200 pl-4">
          {data?.map((t, i) => (
            <li key={i} className="text-sm">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-brand-500" />
              <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{t.title}</span><span className="text-xs text-slate-500">{fmtDateTime(t.at)}</span></div>
              <div className="text-xs text-slate-500">{t.actor ?? 'System'}{t.effectiveAt && new Date(t.effectiveAt).toDateString() !== new Date(t.at).toDateString() ? ` · effective ${fmtDateOnly(t.effectiveAt)}` : ''}{t.ref && <> · {t.ref.type === 'ApprovalRequest' ? <Link href={`/approvals/${t.ref.id}`}>{t.ref.label}</Link> : t.ref.label}</>}</div>
              {t.details.length > 0 && <ul className="mt-0.5 text-xs text-slate-600">{t.details.map((d, j) => <li key={j}>{d}</li>)}</ul>}
            </li>
          ))}
        </ol>
      </Card>
      <Card title="As of a date">
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { setAsOf(await api(`/api/assets/${id}/as-of?date=${date}`)); } catch (x) { setErr(x); } }}>
          <input className="input" type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} required />
          <button className="btn">Show</button>
        </form>
        <ErrorBox error={err} className="mt-2" />
        {asOf && (asOf.existed ? (
          <dl className="kv mt-3">
            <dt>Location</dt><dd>{asOf.location ?? '—'}</dd>
            <dt>Holder</dt><dd>{asOf.holder ?? 'None'}</dd>
            <dt>Status</dt><dd>{label(STATUS_LABEL, asOf.status)}</dd>
            {asOf.inTransit && <><dt>In transit</dt><dd>{asOf.inTransit.transferNo} → {asOf.inTransit.to}</dd></>}
            <dt>Based on</dt><dd className="text-xs">{asOf.basedOn?.kind.replace(/_/g, ' ').toLowerCase()} effective {fmtDateOnly(asOf.basedOn?.effectiveAt)}</dd>
          </dl>
        ) : <p className="mt-3 text-sm text-slate-500">The asset was not registered on that date.</p>)}
      </Card>
    </div>
  );
}

function EditDialog({ open, onClose, a, branchOnly, onDone }: { open: boolean; onClose: () => void; a: Detail; branchOnly: boolean; onDone: (r: unknown) => void }) {
  const init = (): AssetFormValues => ({
    categoryId: a.categoryId, make: a.make, model: a.model, serialNumber: a.serialNumber ?? '', hostname: a.hostname ?? '', ipAddress: a.ipAddress ?? '', macAddress: a.macAddress ?? '', legacyTag: a.legacyTag ?? '',
    purchaseDate: a.raw.purchaseDate?.slice(0, 10) ?? '', purchaseCost: a.purchaseCost ?? '', vendor: a.vendor ?? '', warrantyEnd: a.warrantyEnd?.slice(0, 10) ?? '', condition: a.raw.condition ?? '', remarks: a.raw.remarks ?? '',
    sdpTicketId: a.raw.sdpTicketId ?? '', sdpTicketUrl: a.raw.sdpTicketUrl ?? '', locationId: a.locationId,
  });
  const [v, setV] = useState<AssetFormValues>(init);
  const [serialReason, setSerialReason] = useState('');
  const [dupReason, setDupReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const serialChanged = (v.serialNumber || null) !== (a.serialNumber || null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const orig = init();
      const fields = (Object.keys(v) as (keyof AssetFormValues)[]).filter((k) => k !== 'locationId' && v[k] !== orig[k]);
      if (!fields.length) { onClose(); return; }
      const r = await api(`/api/assets/${a.id}`, { method: 'PATCH', body: { ...toPayload(v, fields), ...(serialChanged ? { serialChangeReason: serialReason } : {}), ...(dupReason ? { duplicateReason: dupReason } : {}) } });
      onDone(r); onClose();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Edit ${a.assetCode}`} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit} disabled={busy}>Save changes</button></>}>
      {branchOnly && <p className="mb-3 text-xs text-slate-500">Branch users can edit hostname, IP, MAC and remarks. Location, holder and status change only through transfers and IT actions.</p>}
      <p className="mb-3 text-xs text-slate-500">The Asset ID cannot be changed. Location, holder and status change through their own actions.</p>
      <AssetFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} mode="edit" branchOnly={branchOnly} />
      {serialChanged && <Field label="Reason for changing the serial number" required className="mt-3"><input className="input" value={serialReason} onChange={(e) => setSerialReason(e.target.value)} /></Field>}
      <div className="mt-3"><DuplicateNotice error={err} reason={dupReason} setReason={setDupReason} /></div>
    </Modal>
  );
}

function SimpleDialog({ open, onClose, title, submitLabel, fields, path, onDone, note }: { open: boolean; onClose: () => void; title: string; submitLabel: string; fields: { k: string; label: string; area?: boolean; required?: boolean }[]; path: string; onDone: (r: unknown) => void; note?: string }) {
  const [v, setV] = useState<Record<string, string>>({});
  return (
    <FormModal open={open} onClose={onClose} title={title} submitLabel={submitLabel} onSubmit={async () => onDone(await api(path, { body: Object.fromEntries(fields.map((f) => [f.k, v[f.k] || null])) }))}>
      {note && <p className="text-sm text-slate-600">{note}</p>}
      {fields.map((f) => (
        <Field key={f.k} label={f.label} required={f.required}>
          {f.area ? <textarea className="input" value={v[f.k] ?? ''} onChange={(e) => setV((x) => ({ ...x, [f.k]: e.target.value }))} required={f.required} /> : <input className="input" value={v[f.k] ?? ''} onChange={(e) => setV((x) => ({ ...x, [f.k]: e.target.value }))} required={f.required} />}
        </Field>
      ))}
    </FormModal>
  );
}

function RetireDialog({ open, onClose, a, onDone }: { open: boolean; onClose: () => void; a: Detail; onDone: (r: unknown) => void }) {
  const [reason, setReason] = useState('');
  const [disposal, setDisposal] = useState('SCRAPPED');
  return (
    <FormModal open={open} onClose={onClose} title={`Retire ${a.assetCode}`} submitLabel="Retire" danger
      onSubmit={async () => onDone(await api(`/api/assets/${a.id}/retire`, { body: { reason, disposalType: disposal } }))}>
      <p className="text-sm text-slate-600">Retired assets are never deleted: they stay searchable with their full history, and can no longer be assigned, transferred or edited (except remarks by an Administrator). Open renewables are cancelled.</p>
      <Field label="Disposal type" required><select className="input" value={disposal} onChange={(e) => setDisposal(e.target.value)}><option value="SCRAPPED">Scrapped</option><option value="SOLD">Sold</option><option value="DONATED">Donated</option><option value="LOST">Lost</option></select></Field>
      <Field label="Reason" required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
    </FormModal>
  );
}

function CorrectDialog({ open, onClose, a, onDone }: { open: boolean; onClose: () => void; a: Detail; onDone: (r: unknown) => void }) {
  const [loc, setLoc] = useState('');
  const [h, setH] = useState<HolderValue>(null);
  const [clearHolder, setClearHolder] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <FormModal open={open} onClose={onClose} title={`Correct ${a.assetCode}`} submitLabel="Apply correction"
      onSubmit={async () => onDone(await api(`/api/assets/${a.id}/correct`, { body: { reason, ...(loc ? { locationId: loc } : {}), ...(clearHolder ? { holder: null } : h ? { holder: { type: h.type, id: h.id } } : {}) } }))}>
      <p className="text-sm text-slate-600">Administrator correction of a data-entry error. It is recorded as a correction movement with your reason, distinct from a real transfer.</p>
      <Field label="Correct location (leave empty to keep)"><LocationSelect value={loc} onChange={setLoc} placeholder={`Keep: ${a.location}`} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearHolder} onChange={(e) => setClearHolder(e.target.checked)} />Remove the holder</label>
      {!clearHolder && <Field label="Correct holder (leave empty to keep)"><HolderPicker value={h} onChange={setH} /></Field>}
      <Field label="Reason" required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} /></Field>
    </FormModal>
  );
}

function ClearFlagDialog({ open, onClose, a, onDone }: { open: boolean; onClose: () => void; a: Detail; onDone: (r: unknown) => void }) {
  const map: Record<string, string> = { Missing: 'MISSING', 'Transfer exception': 'TRANSFER_EXCEPTION', 'Duplicate-suspect': 'DUPLICATE_SUSPECT' };
  const [flag, setFlag] = useState('');
  const [reason, setReason] = useState('');
  return (
    <FormModal open={open} onClose={onClose} title="Clear a flag" submitLabel="Clear flag" disabled={!flag}
      onSubmit={async () => onDone(await api(`/api/assets/${a.id}/clear-flag`, { body: { flag, reason } }))}>
      <Field label="Flag" required><select className="input" value={flag} onChange={(e) => setFlag(e.target.value)}><option value="">Choose</option>{a.flags.map((f) => <option key={f} value={map[f]}>{f}</option>)}</select></Field>
      <Field label="Reason" required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
    </FormModal>
  );
}

