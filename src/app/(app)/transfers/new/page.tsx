'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { extractAssetCode } from '@/lib/asset-code';
import { todayIST } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { AssetStatus } from '@/components/badges';
import { CameraScanner } from '@/components/camera-scanner';
import { useMe } from '@/components/me';
import { LocationSelect, useLocations } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, PageHeader, Spinner, Tabs, useToast } from '@/components/ui';

interface Pick { id: string; assetCode: string; serialNumber: string | null; make: string; model: string; status: string; location?: string | null }

export default function NewTransfer() {
  const me = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const { data: allLocs } = useLocations(false, true);
  const [from, setFrom] = useState(sp.get('from') !== 'selection' ? sp.get('from') ?? (me.isBranch ? me.locationId ?? '' : '') : '');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<Map<string, Pick>>(new Map());
  const [bulkSel, setBulkSel] = useState<{ filter?: Record<string, unknown>; excludeIds?: string[]; count: number } | null>(null);
  const [f, setF] = useState({ reason: '', remarks: '', effectiveDate: todayIST(), linkedReference: '', sdpTicketId: '', sdpTicketUrl: '', invoiceNumber: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('browse');

  // Preselection: from the asset register (ids or all-matching filter) or a single asset.
  useEffect(() => {
    if (sp.get('from') === 'selection') {
      const raw = sessionStorage.getItem('transfer-selection');
      if (!raw) return;
      const s = JSON.parse(raw) as { assetIds?: string[]; filter?: Record<string, unknown>; excludeIds?: string[]; count: number };
      if (s.assetIds) resolve(s.assetIds.join('\n'), true); else setBulkSel(s);
    } else if (sp.get('assetId')) {
      api<Pick & { id: string }>(`/api/assets/${sp.get('assetId')}`).then((a) => setPicked(new Map([[a.id, a]]))).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromLoc = allLocs?.find((l) => l.id === from);
  const toLoc = allLocs?.find((l) => l.id === to);
  const interState = !!(fromLoc?.effectiveState && toLoc?.effectiveState && fromLoc.effectiveState.toLowerCase() !== toLoc.effectiveState.toLowerCase());
  const [paste, setPaste] = useState('');
  const [resolveRes, setResolveRes] = useState<{ unresolved: string[]; invalid: { assetCode: string; message: string }[] } | null>(null);

  async function resolve(text: string, fromSelection = false) {
    const r = await api<{ found: Pick[]; unresolved: string[]; invalid: { assetCode: string; message: string }[] }>('/api/transfers/resolve-identifiers', { body: { text, fromLocationId: from || undefined } });
    setPicked((m) => { const n = new Map(m); r.found.forEach((a) => n.set(a.id, a)); return n; });
    setResolveRes({ unresolved: r.unresolved, invalid: r.invalid });
    if (!fromSelection) setPaste('');
  }

  // Camera scanning: each scan adds one asset and reports what happened to it.
  const [camera, setCamera] = useState(false);
  const [scans, setScans] = useState<{ n: number; code: string; tone: 'green' | 'amber' | 'red'; text: string }[]>([]);
  const scanBusy = useRef(false);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const logScan = (code: string, tone: 'green' | 'amber' | 'red', text: string) => setScans((l) => [{ n: Date.now(), code, tone, text }, ...l].slice(0, 20));
  async function onCameraScan(raw: string) {
    const code = extractAssetCode(raw);
    if (!code || scanBusy.current) return;
    const has = (m: Map<string, Pick>) => [...m.values()].find((a) => a.assetCode.toUpperCase() === code.toUpperCase() || a.serialNumber?.toUpperCase() === code.toUpperCase());
    const dup = has(pickedRef.current);
    if (dup) { logScan(code, 'amber', `${dup.assetCode} is already in this transfer.`); return; }
    scanBusy.current = true;
    try {
      const r = await api<{ found: Pick[]; unresolved: string[]; invalid: { assetCode: string; message: string }[] }>('/api/transfers/resolve-identifiers', { body: { text: code, fromLocationId: from || undefined } });
      const a = r.found[0];
      if (a && pickedRef.current.has(a.id)) logScan(code, 'amber', `${a.assetCode} is already in this transfer.`);
      else if (a) { setPicked((m) => new Map(m).set(a.id, a)); logScan(code, 'green', `Added ${a.assetCode} · ${a.make} ${a.model}`); }
      else if (r.invalid[0]) logScan(code, 'red', r.invalid[0].message);
      else logScan(code, 'red', `No asset matches "${code}" in your scope.`);
    } catch {
      logScan(code, 'red', `"${code}" could not be looked up just now. Check your connection and scan again.`);
    } finally { scanBusy.current = false; }
  }

  const browseQuery = useMemo(() => (from ? `/api/assets${qs({ locationId: from, hasOpenTransfer: 'false', status: ['IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR'], search: '', pageSize: 500, sort: 'assetCode', dir: 'asc' })}` : null), [from]);
  const { data: browse, loading: browsing } = useApi<{ rows: Pick[]; total: number }>(browseQuery);
  const [filterText, setFilterText] = useState('');
  const visible = (browse?.rows ?? []).filter((a) => !filterText || `${a.assetCode} ${a.serialNumber} ${a.make} ${a.model}`.toLowerCase().includes(filterText.toLowerCase()));

  const count = bulkSel ? bulkSel.count : picked.size;
  const submit = async (submitNow: boolean) => {
    setBusy(true); setErr(null);
    try {
      const body = {
        fromLocationId: from, toLocationId: to, reason: f.reason, remarks: f.remarks || null, linkedReference: f.linkedReference || null, sdpTicketId: f.sdpTicketId || null, sdpTicketUrl: f.sdpTicketUrl || null,
        invoiceNumber: f.invoiceNumber || null, ...(me.isIT && f.effectiveDate !== todayIST() ? { effectiveDate: f.effectiveDate } : {}), submit: submitNow,
        ...(bulkSel ? { filter: bulkSel.filter, excludeIds: bulkSel.excludeIds } : { assetIds: [...picked.keys()] }),
      };
      const r = await api<{ transfer: { id: string; transferNo: string; status: string } }>('/api/transfers', { body });
      sessionStorage.removeItem('transfer-selection');
      toast(`${r.transfer.transferNo} ${r.transfer.status === 'PENDING_APPROVAL' ? 'sent for approval' : r.transfer.status === 'IN_TRANSIT' ? 'approved and in transit' : 'saved as draft'}`);
      router.push(`/transfers/${r.transfer.id}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="New transfer" back={{ href: '/transfers', label: 'Transfer register' }} subtitle="Every line is validated together: if any asset fails, nothing is saved and each failing asset is listed." />
      <Card title="Route">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From location" required hint={me.isBranch ? 'Branches send only from their own location.' : 'Assets anywhere under this node can be included.'}>
            <LocationSelect value={from} onChange={(v) => { setFrom(v); setPicked(new Map()); setResolveRes(null); }} required />
          </Field>
          <Field label="To location" required><LocationSelect all value={to} onChange={setTo} required /></Field>
        </div>
        {interState && <div className="mt-2"><Badge tone="purple">Inter-state transfer</Badge> <span className="text-xs text-slate-500">{fromLoc?.effectiveState} → {toLoc?.effectiveState}. An invoice-number reference can be added below.</span></div>}
      </Card>

      <Card title={`Assets (${count.toLocaleString('en-IN')})`}>
        {bulkSel ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{bulkSel.count.toLocaleString('en-IN')} assets selected from the register (all matching the filter{bulkSel.excludeIds?.length ? `, minus ${bulkSel.excludeIds.length}` : ''}).</span>
            <button className="btn btn-sm" onClick={() => setBulkSel(null)}>Pick individually instead</button>
          </div>
        ) : (
          <>
            <Tabs value={tab} onChange={setTab} tabs={[{ key: 'browse', label: 'Pick from location' }, { key: 'paste', label: 'Paste or scan IDs' }]} />
            {tab === 'paste' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn btn-sm" onClick={() => setCamera((c) => !c)}>{camera ? 'Turn off camera' : 'Scan with camera'}</button>
                  <span className="text-xs text-slate-500">Point the camera at each asset label; every scan is added below. USB and Bluetooth scanners type into the box instead.</span>
                </div>
                {camera && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CameraScanner onScan={onCameraScan} />
                    <ul className="max-h-72 space-y-1 overflow-auto text-xs" aria-live="polite">
                      {!scans.length && <li className="text-slate-500">Scanned assets appear here.</li>}
                      {scans.map((x) => (
                        <li key={x.n} className={x.tone === 'green' ? 'rounded bg-green-50 p-1.5 text-green-900' : x.tone === 'amber' ? 'rounded bg-amber-50 p-1.5 text-amber-900' : 'rounded bg-red-50 p-1.5 text-red-900'}>{x.text}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <textarea className="input font-mono text-xs" rows={5} placeholder="Asset IDs, serial numbers or legacy tags — one per line, or separated by commas or spaces. A scanner can type straight into this box." value={paste} onChange={(e) => setPaste(e.target.value)} />
                <button className="btn" disabled={!paste.trim()} onClick={() => resolve(paste).catch((e) => setErr(e))}>Add to transfer</button>
                {resolveRes && (resolveRes.unresolved.length > 0 || resolveRes.invalid.length > 0) && (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                    {resolveRes.unresolved.length > 0 && <div><b>Not found in your scope:</b> {resolveRes.unresolved.join(', ')}</div>}
                    {resolveRes.invalid.map((i) => <div key={i.assetCode}>{i.message}</div>)}
                  </div>
                )}
              </div>
            )}
            {tab === 'browse' && (!from ? <p className="text-sm text-slate-500">Choose the from-location first.</p> : (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input className="input max-w-xs" placeholder="Filter this list" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                  <button className="btn btn-sm" onClick={() => setPicked((m) => { const n = new Map(m); visible.forEach((a) => n.set(a.id, a)); return n; })}>Add all shown ({visible.length})</button>
                  {browsing && <Spinner />}
                  {browse && browse.total > browse.rows.length && <span className="text-xs text-slate-500">Showing first {browse.rows.length} of {browse.total}; use paste or the register&apos;s select-all for more.</span>}
                </div>
                <div className="max-h-72 overflow-auto rounded border">
                  <table className="tbl"><tbody>
                    {visible.map((a) => (
                      <tr key={a.id}>
                        <td className="w-8"><input type="checkbox" checked={picked.has(a.id)} onChange={(e) => setPicked((m) => { const n = new Map(m); if (e.target.checked) n.set(a.id, a); else n.delete(a.id); return n; })} aria-label={`Select ${a.assetCode}`} /></td>
                        <td className="whitespace-nowrap font-medium">{a.assetCode}</td><td>{a.make} {a.model}</td><td>{a.serialNumber ?? '—'}</td><td><AssetStatus s={a.status} /></td><td className="text-xs">{a.location}</td>
                      </tr>
                    ))}
                    {!visible.length && <tr><td className="text-slate-500">No transferable assets here.</td></tr>}
                  </tbody></table>
                </div>
              </div>
            ))}
            {picked.size > 0 && (
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Selected</span><button className="underline" onClick={() => setPicked(new Map())}>Remove all</button></div>
                <div className="flex max-h-40 flex-wrap gap-1 overflow-auto">
                  {[...picked.values()].map((a) => <span key={a.id} className="badge bg-slate-100 text-slate-700">{a.assetCode}<button className="ml-1 text-slate-400 hover:text-red-600" onClick={() => setPicked((m) => { const n = new Map(m); n.delete(a.id); return n; })} aria-label={`Remove ${a.assetCode}`}>✕</button></span>)}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Details">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reason" required className="sm:col-span-2"><textarea className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required /></Field>
          <Field label="Remarks" className="sm:col-span-2"><textarea className="input" rows={2} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
          {me.isIT && <Field label="Effective date" hint="Back-date only to record a move that already happened; it is marked 'recorded late'."><input className="input" type="date" max={todayIST()} value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>}
          <Field label="Linked reference"><input className="input" value={f.linkedReference} onChange={(e) => setF({ ...f, linkedReference: e.target.value })} /></Field>
          <Field label="ServiceDesk Plus ticket ID"><input className="input" value={f.sdpTicketId} onChange={(e) => setF({ ...f, sdpTicketId: e.target.value })} /></Field>
          <Field label="ServiceDesk Plus ticket URL"><input className="input" type="url" value={f.sdpTicketUrl} onChange={(e) => setF({ ...f, sdpTicketUrl: e.target.value })} /></Field>
          {interState && <Field label="Invoice number (inter-state reference)"><input className="input" value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} /></Field>}
        </div>
        <ErrorBox error={err} className="mt-3" />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="btn" disabled={busy || !count || !from || !to} onClick={() => submit(false)}>Save draft</button>
          <button className="btn btn-primary" disabled={busy || !count || !from || !to || !f.reason.trim()} onClick={() => submit(true)}>{busy && <Spinner className="h-3 w-3" />}Submit transfer</button>
        </div>
      </Card>
    </div>
  );
}
