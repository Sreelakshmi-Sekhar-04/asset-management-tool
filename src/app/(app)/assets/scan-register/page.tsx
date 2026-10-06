'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { AssetFields, DuplicateNotice, emptyAsset, toPayload, type AssetFormValues } from '@/components/asset-form';
import { CameraScanner } from '@/components/camera-scanner';
import { PrintLabelsDialog } from '@/components/labels';
import { Card, ErrorBox, PageHeader, Spinner, useToast } from '@/components/ui';

/** Fields that belong to one device; everything else is kept for the next device of the same batch. */
const PER_DEVICE: (keyof AssetFormValues)[] = ['serialNumber', 'hostname', 'ipAddress', 'macAddress', 'legacyTag', 'remarks'];

type Saved = { id: string; assetCode: string } | { pendingId: string; requestNo: string };

/**
 * Quick registration: scan the serial-number barcode on the device (camera, USB or Bluetooth scanner),
 * check the details and save. The same fields and rules as the Register asset form apply.
 */
export default function ScanRegister() {
  const toast = useToast();
  const [camera, setCamera] = useState(true);
  const [typed, setTyped] = useState('');
  const [checking, setChecking] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ id: string; assetCode: string; serial: string } | null>(null);
  const [v, setV] = useState<AssetFormValues>(emptyAsset);
  const [scanned, setScanned] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const pending = useRef('');

  const onSerial = async (raw: string) => {
    const serial = raw.trim();
    if (!serial || pending.current) return;
    pending.current = serial;
    setChecking(true); setScanErr(null); setExisting(null);
    try {
      const hit = await api<{ id: string; assetCode: string }>(`/api/assets/lookup?q=${encodeURIComponent(serial)}`);
      setExisting({ ...hit, serial });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setV((x) => ({ ...x, serialNumber: serial }));
        setScanned(true); setCamera(false); setTyped(''); setErr(null); setReason('');
        setTimeout(() => document.querySelector<HTMLSelectElement>('#scan-register-form select, #scan-register-form input')?.focus(), 50);
      } else setScanErr(e instanceof ApiError && e.status === 400 ? e.message : 'The serial number could not be checked just now. Check your connection and try again.');
    } finally { setChecking(false); pending.current = ''; }
  };

  const nextDevice = () => {
    setV((x) => ({ ...x, ...Object.fromEntries(PER_DEVICE.map((k) => [k, ''])) }));
    setScanned(false); setErr(null); setReason(''); setExisting(null); setCamera(true);
    setTimeout(() => document.querySelector<HTMLInputElement>('input[data-scan]')?.focus(), 50);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ asset?: { id: string; assetCode: string }; pendingApproval?: { id: string; requestNo: string; policy: string } }>('/api/assets', { body: { ...toPayload(v), duplicateReason: reason || null } });
      if (r.asset) { const a = r.asset; setSaved((s) => [a, ...s]); toast(`Registered ${a.assetCode}`); }
      else if (r.pendingApproval) { const p = r.pendingApproval; setSaved((s) => [{ pendingId: p.id, requestNo: p.requestNo }, ...s]); toast(`Sent for approval (${p.requestNo}, ${p.policy})`); }
      nextDevice();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  const registered = saved.filter((s): s is { id: string; assetCode: string } => 'id' in s);
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Scan to register" subtitle="Scan the serial-number barcode on the device, check the details and save. Category, make, model, location and purchase details stay filled in for the next device." back={{ href: '/assets', label: 'Asset register' }} />
      <Card title={scanned ? `Serial ${v.serialNumber}` : '1. Scan the serial number'}
        actions={scanned
          ? <button className="btn btn-sm" onClick={nextDevice}>Scan a different serial</button>
          : <button className="btn btn-sm" onClick={() => setCamera((c) => !c)}>{camera ? 'Turn off camera' : 'Turn on camera'}</button>}>
        {!scanned && <>
          {camera ? <CameraScanner mode="serial" onScan={onSerial} paused={checking || !!existing} className="mx-auto max-w-md" /> : <p className="py-4 text-center text-sm text-slate-500">Camera is off.</p>}
          <form className="mx-auto mt-3 flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); onSerial(typed); }}>
            <input className="input" data-scan placeholder="Serial number" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Serial number" autoComplete="off" autoFocus />
            <button className="btn btn-primary" disabled={checking || !typed.trim()}>Use</button>
          </form>
          <p className="mx-auto mt-2 max-w-md text-xs text-slate-500">USB and Bluetooth scanners type into the box and press Enter. If the sticker has several barcodes, scan the one marked S/N or Serial.</p>
          {checking && <div className="mt-3 flex items-center justify-center gap-2 text-sm text-slate-500"><Spinner />Checking the register…</div>}
          {scanErr && <ErrorBox error={new Error(scanErr)} className="mx-auto mt-3 max-w-md" />}
          {existing && (
            <div className="mx-auto mt-3 max-w-md rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
              Serial <span className="font-medium">{existing.serial}</span> is already registered as <Link href={`/assets/${existing.id}`} className="font-medium">{existing.assetCode}</Link>.
              <div className="mt-2"><button className="btn btn-sm" onClick={() => setExisting(null)}>Scan another</button></div>
            </div>
          )}
        </>}
        {scanned && <p className="text-sm text-slate-600">Not in the register yet. Check the details below; the serial number can be corrected if the wrong barcode was scanned.</p>}
      </Card>
      {scanned && (
        <form id="scan-register-form" onSubmit={submit}>
          <Card title="2. Check details and save">
            <AssetFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} mode="create" />
            <div className="mt-4 space-y-3">
              <DuplicateNotice error={err} reason={reason} setReason={setReason} />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={nextDevice}>Skip this device</button>
                <button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Save and scan next</button>
              </div>
            </div>
          </Card>
        </form>
      )}
      {saved.length > 0 && (
        <Card title={`Saved this session (${saved.length})`} actions={registered.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => setLabelsOpen(true)}>Print {registered.length} label{registered.length === 1 ? '' : 's'}</button>}>
          <ul className="grid gap-1 text-sm sm:grid-cols-3">
            {saved.map((s) => 'id' in s
              ? <li key={s.id}><Link href={`/assets/${s.id}`}>{s.assetCode}</Link></li>
              : <li key={s.pendingId}><Link href={`/approvals/${s.pendingId}`}>{s.requestNo}</Link> <span className="text-slate-500">awaiting approval</span></li>)}
          </ul>
        </Card>
      )}
      <PrintLabelsDialog open={labelsOpen} onClose={() => setLabelsOpen(false)} assetIds={registered.map((s) => s.id)} />
    </div>
  );
}
