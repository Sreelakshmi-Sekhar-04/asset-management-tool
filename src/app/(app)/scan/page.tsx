'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { CameraScanner } from '@/components/camera-scanner';
import { Card, ErrorBox, PageHeader, Spinner } from '@/components/ui';

/** Friendly message for a failed lookup; never shows technical detail. */
function lookupError(e: unknown, code: string) {
  if (e instanceof ApiError && e.status === 404) return `No asset matches "${code}" in your scope. Check the label; the asset may belong to another branch or the label may be from another system.`;
  if (e instanceof ApiError && e.status === 400) return e.message;
  return 'The asset could not be looked up just now. Check your connection and try again.';
}

/** Scan a label (camera, USB scanner or typing); a match opens the asset's page. */
export default function ScanPage() {
  const router = useRouter();
  const [camera, setCamera] = useState(true);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pending = useRef('');

  const look = async (raw: string) => {
    const code = raw.trim();
    if (!code || pending.current) return;
    pending.current = code;
    setBusy(true); setErr(null);
    try {
      const hit = await api<{ id: string }>(`/api/assets/lookup?q=${encodeURIComponent(code)}`);
      setCamera(false);
      router.push(`/assets/${hit.id}?scanned=1`);
    } catch (e) {
      setErr(lookupError(e, code));
      setBusy(false);
      pending.current = '';
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="Scan asset" subtitle="Point the camera at an asset label, or type or scan the Asset ID, serial number or legacy tag. The asset opens as soon as it is found." />
      <Card title="Camera" actions={<button className="btn btn-sm" onClick={() => setCamera((c) => !c)}>{camera ? 'Turn off camera' : 'Turn on camera'}</button>}>
        {camera ? <CameraScanner onScan={look} paused={busy} /> : <p className="py-6 text-center text-sm text-slate-500">Camera is off.</p>}
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); look(manual); }}>
          <input className="input" data-scan placeholder="Asset ID, serial or legacy tag" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Asset ID, serial or legacy tag" autoComplete="off" />
          <button className="btn btn-primary" disabled={busy || !manual.trim()}>Find</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">USB and Bluetooth scanners type into the box and press Enter.</p>
        {busy && <div className="mt-3 flex items-center gap-2 text-sm text-slate-500"><Spinner />Opening asset…</div>}
        {err && <ErrorBox error={new Error(err)} className="mt-3" />}
      </Card>
    </div>
  );
}
