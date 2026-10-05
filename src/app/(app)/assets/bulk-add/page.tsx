'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/components/api';
import { LabelPrintDialog } from '@/components/label-print';
import { CategorySelect, LocationSelect, useCategories } from '@/components/pickers';
import { useScannerAdvance } from '@/components/scanner';
import { Card, ErrorBox, Field, PageHeader, Spinner, useToast } from '@/components/ui';

export default function BulkAdd() {
  const toast = useToast();
  const advance = useScannerAdvance();
  const { data: cats } = useCategories();
  const [f, setF] = useState({ categoryId: '', make: '', model: '', locationId: '', purchaseDate: '', purchaseCost: '', vendor: '', warrantyEnd: '', duplicateReason: '' });
  const [qty, setQty] = useState(5);
  const [items, setItems] = useState<{ serialNumber: string; hostname: string }[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ assetCode: string; id: string; serialNumber: string | null }[] | null>(null);
  const cat = cats?.find((c) => c.id === f.categoryId);
  const prepare = () => { setItems(Array.from({ length: qty }, (_, i) => items[i] ?? { serialNumber: '', hostname: '' })); setDone(null); setTimeout(() => document.querySelector<HTMLInputElement>('input[data-scan]')?.focus(), 50); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ created?: { id: string; assetCode: string; serialNumber: string | null }[]; pendingApproval?: { requestNo: string } }>('/api/assets/bulk-add', {
        body: { ...f, purchaseCost: f.purchaseCost ? Number(f.purchaseCost) : null, purchaseDate: f.purchaseDate || null, warrantyEnd: f.warrantyEnd || null, duplicateReason: f.duplicateReason || null, items: items.map((i) => ({ serialNumber: i.serialNumber || null, hostname: i.hostname || null })) },
      });
      if (r.created) { setDone(r.created); setItems([]); toast(`Created ${r.created.length} assets`); }
      else if (r.pendingApproval) toast(`Sent for approval as ${r.pendingApproval.requestNo}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Bulk add by model × quantity" subtitle="Scan serials into the fields; the scanner's Enter or Tab moves to the next row." back={{ href: '/assets', label: 'Asset register' }} />
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
          <Card title={`2. Serials (${items.filter((i) => i.serialNumber).length} of ${items.length} scanned)`} actions={cat?.serialRequired && <span className="text-xs text-amber-700">Serial required for {cat.name}</span>}>
            <div className="max-h-[50vh] overflow-auto">
              <table className="tbl">
                <thead><tr><th>#</th><th>Serial number</th><th>Hostname (optional)</th></tr></thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="w-10 text-slate-500">{i + 1}</td>
                      <td><input data-scan className="input" value={it.serialNumber} onKeyDown={(e) => advance(e)} onChange={(e) => setItems((x) => x.map((y, j) => (j === i ? { ...y, serialNumber: e.target.value } : y)))} required={cat?.serialRequired} /></td>
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
        <Card title={`Created ${done.length} assets`} actions={<button className="btn btn-sm btn-primary" onClick={() => setPrinting(true)}>Print {done.length} labels</button>}>
          <ul className="grid gap-1 text-sm sm:grid-cols-3">{done.map((d) => <li key={d.id}><Link href={`/assets/${d.id}`}>{d.assetCode}</Link> <span className="text-slate-500">{d.serialNumber}</span></li>)}</ul>
          <LabelPrintDialog open={printing} onClose={() => setPrinting(false)} assetIds={done.map((d) => d.id)} />
        </Card>
      )}
    </div>
  );
}
