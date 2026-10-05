'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { daysBetween, dateOnly, fmtDateOnly, fmtDateTime, todayIST } from '@/lib/format';
import { HOLDER_TYPE_LABEL, label } from '@/lib/labels';
import { api, ApiError } from '@/components/api';
import { AssetStatus, DaysBadge, Flags } from '@/components/badges';
import { CameraScanner, scanFeedback } from '@/components/camera-scanner';
import { LabelPrintDialog } from '@/components/label-print';
import { useMe } from '@/components/me';
import { Badge, Card, ErrorBox, PageHeader, Spinner } from '@/components/ui';

interface Found {
  id: string; assetCode: string; category: string; make: string; model: string; serialNumber: string | null; status: string; location: string | null; locationId: string;
  holder: string | null; holderType: string | null; warrantyEnd: string | null; flags: string[];
  openTransfer: { id: string; transferNo: string; toLocation: string } | null; pendingApprovals: { id: string; requestNo: string; summary: string }[];
}
interface TL { at: string; title: string; actor: string | null }
type Result =
  | { kind: 'asset'; code: string; at: number; matchedBy: string; asset: Found; timeline: TL[] }
  | { kind: 'unknown'; code: string; at: number }
  | { kind: 'error'; code: string; at: number; message: string };

const MATCHED: Record<string, string> = { serial: 'serial number', legacyTag: 'legacy tag', number: 'running number' };
const CAMERA_PREF = 'itam:scan-camera';

export default function ScanPage() {
  const me = useMe();
  const inputRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Result | null>(null);
  const [history, setHistory] = useState<Result[]>([]);
  const [printing, setPrinting] = useState(false);

  // Phones and tablets start with the camera; desktops start with the USB scanner / keyboard box.
  useEffect(() => {
    let pref: string | null = null;
    try { pref = localStorage.getItem(CAMERA_PREF); } catch { /* storage unavailable */ }
    setCamera(pref ? pref === '1' : window.matchMedia('(pointer: coarse)').matches);
  }, []);
  useEffect(() => { if (camera === false) inputRef.current?.focus(); }, [camera]);
  const toggleCamera = () => { const v = !camera; setCamera(v); try { localStorage.setItem(CAMERA_PREF, v ? '1' : '0'); } catch { /* storage unavailable */ } };

  const lookup = async (raw: string) => {
    const code = raw.trim();
    if (!code || busy) return;
    setBusy(true);
    let r: Result;
    try {
      const hit = await api<{ id: string; matchedBy: string }>(`/api/assets/lookup?q=${encodeURIComponent(code)}`);
      const [asset, timeline] = await Promise.all([api<Found>(`/api/assets/${hit.id}`), api<TL[]>(`/api/assets/${hit.id}/timeline`).catch(() => [])]);
      r = { kind: 'asset', code, at: Date.now(), matchedBy: hit.matchedBy, asset, timeline: timeline.slice(0, 5) };
      scanFeedback('ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { r = { kind: 'unknown', code, at: Date.now() }; scanFeedback('warn'); }
      else { r = { kind: 'error', code, at: Date.now(), message: 'The lookup did not complete. Check your connection and scan again.' }; scanFeedback('error'); }
    } finally { setBusy(false); }
    setCurrent(r);
    // One row per asset, however it was found (Asset ID, serial or number); one per unknown code.
    const key = (e: Result) => (e.kind === 'asset' ? `asset:${e.asset.id}` : `code:${e.code.toUpperCase()}`);
    setHistory((h) => [r, ...h.filter((x) => key(x) !== key(r))].slice(0, 25));
  };

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const v = inputRef.current?.value ?? '';
    if (inputRef.current) inputRef.current.value = '';
    lookup(v);
  };

  // Desktop: history under the scanner. Phones: under the result, so each scan's result is in view.
  const historyCard = history.length > 0 && (
            <Card title="Scanned this session" actions={<span className="text-xs text-slate-500">{history.length}</span>} bodyClass="p-0">
              <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
                {history.map((h) => (
                  <li key={h.at}>
                    <button type="button" onClick={() => setCurrent(h)} className={clsx('flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-slate-50', current?.at === h.at && 'bg-slate-50')}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono font-medium">{h.kind === 'asset' ? h.asset.assetCode : h.code}</span>
                        {h.kind === 'asset' && <span className="block truncate text-xs text-slate-500">{h.asset.make} {h.asset.model}</span>}
                      </span>
                      {h.kind === 'asset' ? <AssetStatus s={h.asset.status} /> : <Badge tone={h.kind === 'unknown' ? 'amber' : 'red'}>{h.kind === 'unknown' ? 'Not found' : 'Failed'}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          );

  return (
    <div>
      <PageHeader title="Scan asset" subtitle="Scan an asset label or barcode, or type an Asset ID, serial number or legacy tag." back={{ href: '/assets', label: 'Asset register' }} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="space-y-4 lg:sticky lg:top-16">
          <Card>
            <div className="space-y-3">
              {camera && <CameraScanner onDetect={lookup} paused={busy} />}
              <form onSubmit={submitTyped} className="flex gap-2">
                <input ref={inputRef} data-scan className="input font-mono" placeholder="Asset ID, serial or legacy tag" aria-label="Asset ID, serial or legacy tag"
                  autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go" />
                <button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Look up</button>
              </form>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">USB and Bluetooth scanners type into the box and press Enter.</p>
                {camera !== null && <button type="button" className="btn btn-sm" onClick={toggleCamera}>{camera ? 'Turn camera off' : 'Use camera'}</button>}
              </div>
            </div>
          </Card>
          <div className="hidden lg:block">{historyCard}</div>
        </div>

        <div aria-live="polite" className={clsx('transition-opacity', busy && 'opacity-60')}>
          {!current ? (
            <Card>
              <div className="py-10 text-center">
                {busy ? <Spinner className="h-6 w-6" /> : <div className="text-base font-semibold">Ready to scan</div>}
                <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">Point the camera at an asset label, use a USB scanner, or type an Asset ID. You can also type just its number, for example <span className="font-mono">123</span>.</p>
              </div>
            </Card>
          ) : current.kind === 'asset' ? (
            <AssetResult r={current} isIT={me.isIT} onPrint={() => setPrinting(true)} />
          ) : current.kind === 'unknown' ? (
            <Card className="border-amber-200">
              <div className="font-semibold">No asset found</div>
              <p className="mt-1 break-all text-sm text-slate-600">Nothing in {me.isBranch ? 'your branch' : 'the register'} has the Asset ID, serial number or legacy tag <span className="font-mono font-medium text-slate-900">{current.code}</span>.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {me.isIT && <Link className="btn btn-primary" href={`/assets/new?serial=${encodeURIComponent(current.code)}`}>Register as new asset</Link>}
                <Link className="btn" href={`/assets?search=${encodeURIComponent(current.code)}`}>Search the register</Link>
              </div>
              {me.isBranch && <p className="mt-3 text-xs text-slate-500">If the asset is physically here but not listed, report it through your verification task so IT can register it.</p>}
            </Card>
          ) : (
            <ErrorBox error={new Error(current.message)} />
          )}
        </div>
        <div className="lg:hidden">{historyCard}</div>
      </div>
      {current?.kind === 'asset' && <LabelPrintDialog open={printing} onClose={() => setPrinting(false)} assetIds={[current.asset.id]} title={`Print label for ${current.asset.assetCode}`} />}
    </div>
  );
}

function AssetResult({ r, isIT, onPrint }: { r: Extract<Result, { kind: 'asset' }>; isIT: boolean; onPrint: () => void }) {
  const a = r.asset;
  const retired = a.status === 'RETIRED';
  const locked = !!a.openTransfer || a.pendingApprovals.length > 0;
  const act = (action: string) => `/assets/${a.id}?action=${action}`;
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono text-base">{a.assetCode}</span><AssetStatus s={a.status} /><Flags flags={a.flags} /></span>}
      actions={r.matchedBy !== 'assetCode' && <span className="text-xs text-slate-500">Matched by {MATCHED[r.matchedBy] ?? r.matchedBy}</span>}>
      <p className="text-sm text-slate-600">{a.category} · {a.make} {a.model}</p>
      {a.openTransfer && <div className="mt-3 rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-sm">In transfer <Link href={`/transfers/${a.openTransfer.id}`}>{a.openTransfer.transferNo}</Link> to {a.openTransfer.toLocation}.</div>}
      {a.pendingApprovals.map((p) => <div key={p.id} className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">Pending approval <Link href={`/approvals/${p.id}`}>{p.requestNo}</Link>: {p.summary}</div>)}
      <dl className="kv mt-3">
        <dt>Location</dt><dd>{a.location ?? '—'}</dd>
        <dt>Assigned to</dt><dd>{a.holder ? `${a.holder} (${label(HOLDER_TYPE_LABEL, a.holderType)})` : 'Nobody'}</dd>
        <dt>Serial</dt><dd className="font-mono">{a.serialNumber ?? '—'}</dd>
        <dt>Warranty end</dt><dd>{a.warrantyEnd ? <>{fmtDateOnly(a.warrantyEnd)} <DaysBadge days={daysBetween(dateOnly(todayIST()), new Date(a.warrantyEnd))} /></> : '—'}</dd>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="btn btn-primary" href={`/assets/${a.id}`}>Open asset</Link>
        {isIT && !retired && !locked && (a.status === 'IN_STOCK' || a.status === 'ASSIGNED') && <Link className="btn" href={act('assign')}>{a.status === 'ASSIGNED' ? 'Reassign' : 'Assign'}</Link>}
        {isIT && !locked && a.status === 'ASSIGNED' && <Link className="btn" href={act('checkin')}>Check in</Link>}
        {isIT && !locked && (a.status === 'IN_STOCK' || a.status === 'ASSIGNED') && <Link className="btn" href={act('repair')}>Send to repair</Link>}
        {isIT && !locked && a.status === 'UNDER_REPAIR' && <Link className="btn" href={act('repairdone')}>Repair done</Link>}
        {!retired && !locked && <Link className="btn" href={`/transfers/new?assetId=${a.id}&from=${a.locationId}`}>Transfer</Link>}
        <button className="btn" onClick={onPrint}>Print label</button>
      </div>
      <div className="mt-5 border-t border-slate-100 pt-3">
        <div className="mb-2 text-sm font-semibold">Recent activity</div>
        {r.timeline.length === 0 ? <p className="text-sm text-slate-500">No history yet.</p> : (
          <ol className="space-y-1.5">
            {r.timeline.map((t, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-x-3 text-sm">
                <span>{t.title}<span className="text-xs text-slate-500"> · {t.actor ?? 'System'}</span></span>
                <span className="text-xs text-slate-500">{fmtDateTime(t.at)}</span>
              </li>
            ))}
          </ol>
        )}
        <Link href={`/assets/${a.id}`} className="mt-2 inline-block text-sm">Full history →</Link>
      </div>
    </Card>
  );
}
