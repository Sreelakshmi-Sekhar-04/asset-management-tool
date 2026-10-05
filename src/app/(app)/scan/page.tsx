'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { HOLDER_TYPE_LABEL, label } from '@/lib/labels';
import { api, ApiError } from '@/components/api';
import { AssetStatus, Flags } from '@/components/badges';
import { CameraScanner } from '@/components/camera-scanner';
import { PrintLabelsDialog } from '@/components/labels';
import { Card, ErrorBox, PageHeader, Spinner } from '@/components/ui';

interface Found {
  id: string; assetCode: string; category: string; make: string; model: string; serialNumber: string | null; status: string; location: string | null; locationId: string;
  holder: string | null; holderType: string | null; flags: string[]; openTransfer: { id: string; transferNo: string; toLocation: string } | null; pendingApprovals: unknown[];
}

/** Friendly message for a failed lookup; never shows technical detail. */
function lookupError(e: unknown, code: string) {
  if (e instanceof ApiError && e.status === 404) return `No asset matches "${code}" in your scope. Check the label; the asset may belong to another branch or the label may be from another system.`;
  if (e instanceof ApiError && e.status === 400) return e.message;
  return 'The asset could not be looked up just now. Check your connection and try again.';
}

export default function ScanPage() {
  const [camera, setCamera] = useState(true);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [asset, setAsset] = useState<Found | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const pending = useRef('');

  const look = async (raw: string) => {
    const code = raw.trim();
    if (!code || pending.current === code) return;
    pending.current = code;
    setBusy(true); setErr(null);
    try {
      const hit = await api<{ id: string }>(`/api/assets/lookup?q=${encodeURIComponent(code)}`);
      setAsset(await api<Found>(`/api/assets/${hit.id}`));
    } catch (e) {
      setAsset(null); setErr(lookupError(e, code));
    } finally { setBusy(false); pending.current = ''; }
  };

  const locked = !!asset && (!!asset.openTransfer || asset.pendingApprovals.length > 0);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Scan asset" subtitle="Point the camera at an asset label, or type or scan the Asset ID, serial number or legacy tag." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Camera" actions={<button className="btn btn-sm" onClick={() => setCamera((c) => !c)}>{camera ? 'Turn off camera' : 'Turn on camera'}</button>}>
          {camera ? <CameraScanner onScan={look} paused={busy} /> : <p className="py-6 text-center text-sm text-slate-500">Camera is off.</p>}
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); look(manual).then(() => setManual('')); }}>
            <input className="input" data-scan placeholder="Asset ID, serial or legacy tag" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Asset ID, serial or legacy tag" autoComplete="off" />
            <button className="btn btn-primary" disabled={busy || !manual.trim()}>Find</button>
          </form>
        </Card>
        <div className="space-y-3">
          {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner />Looking up…</div>}
          {err && <ErrorBox error={new Error(err)} />}
          {!asset && !err && !busy && <Card><p className="py-6 text-center text-sm text-slate-500">Scan a label to see the asset here.</p></Card>}
          {asset && (
            <Card title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{asset.assetCode}</span> <AssetStatus s={asset.status} /> <Flags flags={asset.flags} /></span>}>
              <dl className="kv">
                <dt>Asset</dt><dd>{asset.category} · {asset.make} {asset.model}</dd>
                <dt>Serial</dt><dd>{asset.serialNumber ?? '—'}</dd>
                <dt>Location</dt><dd>{asset.location ?? '—'}</dd>
                <dt>Holder</dt><dd>{asset.holder ? `${asset.holder} (${label(HOLDER_TYPE_LABEL, asset.holderType)})` : 'None'}</dd>
              </dl>
              {asset.openTransfer && <p className="mt-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-sm">In transfer <Link href={`/transfers/${asset.openTransfer.id}`}>{asset.openTransfer.transferNo}</Link> to {asset.openTransfer.toLocation}.</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link className="btn btn-primary" href={`/assets/${asset.id}`}>Open asset</Link>
                {asset.status !== 'RETIRED' && !locked && <Link className="btn" href={`/transfers/new?assetId=${asset.id}&from=${asset.locationId}`}>Transfer</Link>}
                <button className="btn" onClick={() => setLabelOpen(true)}>Print label</button>
              </div>
              <p className="mt-2 text-xs text-slate-500">Assign, check in, repair, history and documents are on the asset page.</p>
            </Card>
          )}
        </div>
      </div>
      {asset && <PrintLabelsDialog open={labelOpen} onClose={() => setLabelOpen(false)} assetIds={[asset.id]} title={`Print label for ${asset.assetCode}`} />}
    </div>
  );
}
