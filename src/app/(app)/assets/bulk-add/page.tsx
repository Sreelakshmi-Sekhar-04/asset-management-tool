'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { CameraScanner } from '@/components/camera-scanner';
import { ImportPanel } from '@/components/import-panel';
import { PrintLabelsDialog } from '@/components/labels';
import { CategorySelect, LocationSelect, useCategories } from '@/components/pickers';
import { useScannerAdvance } from '@/components/scanner';
import { Card, ErrorBox, Field, PageHeader, Spinner, Tabs, useToast } from '@/components/ui';

type Row = { serialNumber: string; hostname: string };
type ScanNote = { n: number; text: string; tone: 'green' | 'amber' | 'red' };
/** Existing asset a serial matches, or null when it is not in the register yet. */
type Registered = Record<string, { id: string; assetCode: string } | null>;

const norm = (s: string) => s.trim().toLowerCase();

const TABS = [
  { key: 'serials', label: 'Scan or type serials', subtitle: 'Many devices of the same make and model: enter the common details once, then scan each serial-number barcode with the camera or a USB or Bluetooth scanner, or type it.' },
  { key: 'excel', label: 'Upload Excel / CSV', subtitle: 'An existing list or a supplier’s delivery sheet, with different models per row. A dry run shows every row, in the asset register’s columns, before anything is saved.' },
];

/** One page for adding many assets at once: scan or type serials, or upload a spreadsheet. */
function BulkAddOrImport() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = sp.get('tab') === 'excel' ? 'excel' : 'serials';
  const t = TABS.find((x) => x.key === tab)!;
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Bulk add / Import" subtitle={t.subtitle} back={{ href: '/assets', label: 'Asset register' }} />
      <Tabs tabs={TABS} value={tab} onChange={(k) => router.replace(k === 'serials' ? pathname : `${pathname}?tab=${k}`, { scroll: false })} />
      {tab === 'excel' ? <ImportPanel assetsOnly /> : <ScanSerials />}
    </div>
  );
}

export default function BulkAddPage() { return <Suspense><BulkAddOrImport /></Suspense>; }

function ScanSerials() {
  const toast = useToast();
  const advance = useScannerAdvance();
  const { data: cats } = useCategories();
  const [f, setF] = useState({ categoryId: '', make: '', model: '', locationId: '', purchaseDate: '', purchaseCost: '', vendor: '', warrantyEnd: '', duplicateReason: '' });
  const [qty, setQty] = useState(5);
  const [items, setItemsState] = useState<Row[]>([]);
  // Mirrors items synchronously so back-to-back camera scans each land in their own row.
  const itemsRef = useRef<Row[]>([]);
  const setItems = (next: Row[] | ((x: Row[]) => Row[])) => {
    itemsRef.current = typeof next === 'function' ? next(itemsRef.current) : next;
    setItemsState(itemsRef.current);
  };
  const [camera, setCamera] = useState(false);
  const [scans, setScans] = useState<ScanNote[]>([]);
  const [registered, setRegistered] = useState<Registered>({});
  const checked = useRef(new Set<string>());
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ assetCode: string; id: string; serialNumber: string | null }[] | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const cat = cats?.find((c) => c.id === f.categoryId);
  const prepare = () => { setItems(Array.from({ length: qty }, (_, i) => items[i] ?? { serialNumber: '', hostname: '' })); setDone(null); setTimeout(() => document.querySelector<HTMLInputElement>('input[data-scan]')?.focus(), 50); };
  const note = (text: string, tone: ScanNote['tone']) => setScans((x) => [{ n: Date.now() + Math.random(), text, tone }, ...x].slice(0, 50));
  const setSerial = (i: number, serialNumber: string) => setItems((x) => x.map((y, j) => (j === i ? { ...y, serialNumber } : y)));

  /** Looks the serial up in the register once; returns the matching asset, if any. */
  const checkRegistered = async (serial: string) => {
    const k = norm(serial);
    if (!k || checked.current.has(k)) return registered[k] ?? null;
    checked.current.add(k);
    try {
      const hit = await api<{ id: string; assetCode: string }>(`/api/assets/lookup?q=${encodeURIComponent(serial.trim())}`);
      setRegistered((r) => ({ ...r, [k]: hit }));
      return hit;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setRegistered((r) => ({ ...r, [k]: null }));
      else checked.current.delete(k);
      return null;
    }
  };

  /** Each camera scan fills the next empty serial row. */
  const onCameraScan = async (raw: string) => {
    const serial = raw.trim();
    if (!serial) return;
    const rows = itemsRef.current;
    const dup = rows.findIndex((r) => norm(r.serialNumber) === norm(serial));
    if (dup >= 0) { note(`${serial} is already in row ${dup + 1}. Not added again.`, 'amber'); return; }
    const i = rows.findIndex((r) => !r.serialNumber.trim());
    if (i < 0) { note(`All ${rows.length} rows are filled, so ${serial} was not added. Raise the quantity and prepare the rows again to add more.`, 'red'); return; }
    setSerial(i, serial);
    const hit = await checkRegistered(serial);
    if (hit) note(`Row ${i + 1}: ${serial} is already registered as ${hit.assetCode}. Clear or replace this row.`, 'red');
    else note(`Row ${i + 1}: ${serial}`, 'green');
  };

  const rowsByKey = new Map<string, number[]>();
  items.forEach((it, i) => { const k = norm(it.serialNumber); if (k) rowsByKey.set(k, [...(rowsByKey.get(k) ?? []), i]); });
  const filled = items.filter((i) => i.serialNumber.trim()).length;
  const allFilled = items.length > 0 && filled === items.length;
  const problemCount = items.filter((it) => { const k = norm(it.serialNumber); return k && ((rowsByKey.get(k)?.length ?? 0) > 1 || registered[k]); }).length;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ created?: { id: string; assetCode: string; serialNumber: string | null }[]; pendingApproval?: { requestNo: string } }>('/api/assets/bulk-add', {
        body: { ...f, purchaseCost: f.purchaseCost ? Number(f.purchaseCost) : null, purchaseDate: f.purchaseDate || null, warrantyEnd: f.warrantyEnd || null, duplicateReason: f.duplicateReason || null, items: items.map((i) => ({ serialNumber: i.serialNumber || null, hostname: i.hostname || null })) },
      });
      if (r.created) { setDone(r.created); setItems([]); setCamera(false); setScans([]); toast(`Created ${r.created.length} assets`); }
      else if (r.pendingApproval) toast(`Sent for approval as ${r.pendingApproval.requestNo}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const clsxProblem = (serial: string) => {
    const k = norm(serial);
    return k && ((rowsByKey.get(k)?.length ?? 0) > 1 || registered[k]) ? 'input border-red-400 bg-red-50' : 'input';
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="space-y-4">
      <Card title="1. Common details">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Category" required><CategorySelect value={f.categoryId} onChange={(id) => setF((x) => ({ ...x, categoryId: id }))} /></Field>
          <Field label="Make" required><input className="input" value={f.make} onChange={set('make')} /></Field>
          <Field label="Model" required><input className="input" value={f.model} onChange={set('model')} /></Field>
          <Field label="Location" required><LocationSelect value={f.locationId} onChange={(id) => setF((x) => ({ ...x, locationId: id }))} /></Field>
          <Field label="Purchase date"><input className="input" type="date" value={f.purchaseDate} onChange={set('purchaseDate')} /></Field>
          <Field label="Unit cost (₹)"><input className="input" type="number" min={0} value={f.purchaseCost} onChange={set('purchaseCost')} /></Field>
          <Field label="Vendor"><input className="input" value={f.vendor} onChange={set('vendor')} /></Field>
          <Field label="Warranty end"><input className="input" type="date" value={f.warrantyEnd} onChange={set('warrantyEnd')} /></Field>
          <Field label="Quantity (1–500)"><div className="flex gap-2"><input className="input" type="number" min={1} max={500} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} /><button type="button" className="btn" onClick={prepare} disabled={!f.categoryId || !f.make || !f.model || !f.locationId}>Prepare {qty} rows</button></div></Field>
        </div>
      </Card>
      {items.length > 0 && (
        <form onSubmit={save}>
          <Card title={`2. Serials (${filled} of ${items.length} scanned)`} actions={cat?.serialRequired && <span className="text-xs text-amber-700">Serial required for {cat.name}</span>}>
            <div className="mb-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={camera ? 'btn' : 'btn btn-primary'} onClick={() => setCamera((c) => !c)}>{camera ? 'Turn off camera' : '📷 Scan serials with camera'}</button>
                <span className="text-xs text-slate-500">Each scan fills the next empty row. You can also click a row and type, or scan into it with a USB or Bluetooth scanner.</span>
              </div>
              {camera && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <CameraScanner mode="serial" onScan={onCameraScan} paused={allFilled} />
                  <div>
                    {allFilled && <p className="mb-2 rounded bg-green-50 p-2 text-xs text-green-900">All {items.length} rows have a serial. Check them below, then create the assets.</p>}
                    <ul className="max-h-72 space-y-1 overflow-auto text-xs" aria-live="polite">
                      {!scans.length && <li className="text-slate-500">Scanned serials appear here. If the sticker has several barcodes, scan the one marked S/N or Serial.</li>}
                      {scans.map((x) => (
                        <li key={x.n} className={x.tone === 'green' ? 'rounded bg-green-50 p-1.5 text-green-900' : x.tone === 'amber' ? 'rounded bg-amber-50 p-1.5 text-amber-900' : 'rounded bg-red-50 p-1.5 text-red-900'}>{x.text}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            {problemCount > 0 && <p className="mb-2 rounded bg-red-50 p-2 text-xs text-red-900">{problemCount} row{problemCount === 1 ? ' has a serial' : 's have serials'} that repeat or are already registered. Fix them before creating the assets.</p>}
            <div className="max-h-[50vh] overflow-auto">
              <table className="tbl">
                <thead><tr><th>#</th><th>Serial number</th><th>Hostname (optional)</th></tr></thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="w-10 text-slate-500">{i + 1}</td>
                      <td>
                        <input data-scan className={clsxProblem(it.serialNumber)} value={it.serialNumber} aria-label={`Serial number, row ${i + 1}`} autoComplete="off"
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') checkRegistered(it.serialNumber); advance(e); }}
                          onBlur={() => checkRegistered(it.serialNumber)}
                          onChange={(e) => setSerial(i, e.target.value)} required={cat?.serialRequired} />
                        <RowProblem serial={it.serialNumber} row={i} rowsByKey={rowsByKey} registered={registered} onClear={() => setSerial(i, '')} />
                      </td>
                      <td><input className="input" value={it.hostname} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, hostname: e.target.value } : y)))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Field label="Reason, if hostnames duplicate existing assets" className="mt-3"><input className="input" value={f.duplicateReason} onChange={set('duplicateReason')} /></Field>
            <ErrorBox error={err} className="mt-3" />
            <div className="mt-3 flex justify-end"><button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Create {items.length} assets</button></div>
          </Card>
        </form>
      )}
      {done && (
        <Card title={`Created ${done.length} assets`} actions={<button className="btn btn-sm btn-primary" onClick={() => setLabelsOpen(true)}>Print labels</button>}>
          <ul className="grid gap-1 text-sm sm:grid-cols-3">{done.map((d) => <li key={d.id}><Link href={`/assets/${d.id}`}>{d.assetCode}</Link> <span className="text-slate-500">{d.serialNumber}</span></li>)}</ul>
        </Card>
      )}
      <PrintLabelsDialog open={labelsOpen} onClose={() => setLabelsOpen(false)} assetIds={(done ?? []).map((d) => d.id)} />
    </div>
  );
}

/** Says why a serial row cannot be saved: repeated in another row, or already in the register. */
function RowProblem({ serial, row, rowsByKey, registered, onClear }: { serial: string; row: number; rowsByKey: Map<string, number[]>; registered: Registered; onClear: () => void }) {
  const k = norm(serial);
  if (!k) return null;
  const others = (rowsByKey.get(k) ?? []).filter((j) => j !== row);
  const hit = registered[k];
  if (!others.length && !hit) return null;
  return (
    <p className="mt-1 text-xs text-red-700">
      {hit ? <>Already registered as <Link href={`/assets/${hit.id}`} className="font-medium">{hit.assetCode}</Link>.</> : <>Also in row {others.map((j) => j + 1).join(', ')}.</>}
      {' '}<button type="button" className="underline" onClick={onClear}>Clear</button>
    </p>
  );
}
