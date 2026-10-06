'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatAssetCode, type AssetIdFormat, type LabelSettings } from '@/lib/asset-code';
import { api, useApi } from '@/components/api';
import { Card, ErrorBox, Field, PageHeader, Spinner, useToast } from '@/components/ui';

interface Config {
  format: AssetIdFormat; labels: LabelSettings; nextGlobal: number; counters: { prefix: string; nextValue: number }[];
  categories: { id: string; name: string; code: string | null }[]; assetCount: number; appUrl: string;
}
type Preview = { category: string; code: string | null; example: string }[];

export default function AssetIdsPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<Config>('/api/settings/asset-ids');
  const [f, setF] = useState<AssetIdFormat | null>(null);
  const [next, setNext] = useState(1);
  const [l, setL] = useState<LabelSettings | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errF, setErrF] = useState<unknown>(null);
  const [errL, setErrL] = useState<unknown>(null);
  const [busy, setBusy] = useState<'' | 'f' | 'l'>('');
  useEffect(() => { if (data) { setF(data.format); setNext(data.nextGlobal); setL(data.labels); } }, [data]);
  useEffect(() => {
    if (!f) return;
    const t = setTimeout(() => { api<Preview>('/api/settings/asset-ids/preview', { body: f }).then(setPreview).catch(() => setPreview(null)); }, 300);
    return () => clearTimeout(t);
  }, [f]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !f || !l) return <div className="flex justify-center py-20"><Spinner /></div>;

  const set = (p: Partial<AssetIdFormat>) => setF({ ...f, ...p });
  const missingCodes = f.includeCategoryCode ? data.categories.filter((c) => !c.code) : [];
  const saveFormat = async () => {
    setBusy('f'); setErrF(null);
    try { await api('/api/settings/asset-ids', { method: 'PUT', body: { ...f, nextNumber: f.numbering === 'GLOBAL' ? next : undefined } }); toast('Asset ID format saved. New assets use it from now on.'); reload(); }
    catch (e) { setErrF(e); } finally { setBusy(''); }
  };
  const saveLabels = async () => {
    setBusy('l'); setErrL(null);
    try { await api('/api/settings/labels', { method: 'PUT', body: l }); toast('Label settings saved'); reload(); }
    catch (e) { setErrL(e); } finally { setBusy(''); }
  };

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Asset IDs & labels" subtitle="How new Asset IDs are built, and what the printed QR labels look like. Every change is recorded in the audit log." />

      <Card title="Asset ID format" actions={<button className="btn btn-sm btn-primary" disabled={busy === 'f'} onClick={saveFormat}>{busy === 'f' && <Spinner className="h-3 w-3" />}Save format</button>}>
        <div className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          The system assigns the Asset ID when an asset is saved. An Asset ID never changes and is never reused. A new format applies only to assets created
          afterwards: the {data.assetCount.toLocaleString('en-IN')} existing assets keep their IDs, and their labels stay valid.
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Prefix" required hint="Letters and digits, e.g. AST or IT.">
            <input className="input font-mono uppercase" value={f.prefix} maxLength={10} onChange={(e) => set({ prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
          </Field>
          <Field label="Separator">
            <select className="input" value={f.separator} onChange={(e) => set({ separator: e.target.value as AssetIdFormat['separator'] })}>
              <option value="-">Hyphen ({formatAssetCode({ ...f, separator: '-' }, 1, f.includeCategoryCode ? 'LAP' : null)})</option>
              <option value="">None ({formatAssetCode({ ...f, separator: '' }, 1, f.includeCategoryCode ? 'LAP' : null)})</option>
            </select>
          </Field>
          <Field label="Number of digits" hint="Zero-padded; grows if numbers run past it.">
            <input className="input" type="number" min={3} max={10} value={f.digits} onChange={(e) => set({ digits: Number(e.target.value) })} />
          </Field>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.includeCategoryCode} onChange={(e) => set({ includeCategoryCode: e.target.checked })} />
          <span>Include the category code, e.g. <span className="font-mono">{formatAssetCode({ ...f, includeCategoryCode: true }, 1, 'LAP')}</span> for a laptop.
            <span className="block text-xs text-slate-500">Codes are set per category in <Link href="/admin/master-data">Categories & departments</Link>. If an asset later moves to another category, it keeps its Asset ID.</span></span>
        </label>
        {missingCodes.length > 0 && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {missingCodes.length} active categor{missingCodes.length === 1 ? 'y has' : 'ies have'} no code ({missingCodes.slice(0, 6).map((c) => c.name).join(', ')}{missingCodes.length > 6 ? ', …' : ''}). Their assets get IDs without a category part.
          </div>
        )}
        <fieldset className="mt-4">
          <legend className="field-label">Numbering</legend>
          <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={f.numbering === 'GLOBAL'} onChange={() => set({ numbering: 'GLOBAL' })} />
            <span>One running number for all assets <span className="block text-xs text-slate-500">Every new asset gets the next number, whatever its category: …-000101, …-000102.</span></span></label>
          <label className="mt-2 flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={f.numbering === 'PER_PREFIX'} onChange={() => set({ numbering: 'PER_PREFIX' })} />
            <span>A separate running number for each prefix and category code <span className="block text-xs text-slate-500">IT-LAP-00001, IT-LAP-00002 and IT-DSK-00001 count independently.</span></span></label>
        </fieldset>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {f.numbering === 'GLOBAL'
            ? <Field label="Next number" hint={`Can only move forward. Currently ${data.nextGlobal.toLocaleString('en-IN')}.`}><input className="input" type="number" min={data.nextGlobal} value={next} onChange={(e) => setNext(Number(e.target.value))} /></Field>
            : <Field label="Start new prefixes at" hint="Used the first time a prefix is used. Numbers already used under that prefix are skipped."><input className="input" type="number" min={1} value={f.startNumber} onChange={(e) => set({ startNumber: Number(e.target.value) })} /></Field>}
        </div>
        <div className="mt-4">
          <div className="field-label">Next Asset IDs with this format</div>
          {!preview ? <p className="text-xs text-slate-500">Fix the values above to see a preview.</p> : (
            <div className="table-wrap max-h-60 overflow-y-auto rounded border"><table className="tbl">
              <thead><tr><th>Category</th><th>Next Asset ID</th></tr></thead>
              <tbody>{preview.map((p) => <tr key={p.category}><td>{p.category}{p.code ? <span className="ml-1 font-mono text-xs text-slate-500">{p.code}</span> : null}</td><td className="font-mono">{f.numbering === 'GLOBAL' ? formatAssetCode(f, next, p.code) : p.example}</td></tr>)}</tbody>
            </table></div>
          )}
          {f.numbering === 'GLOBAL' && f.includeCategoryCode && <p className="mt-1 text-xs text-slate-500">With one running number, each row shows what the very next asset would get if it were in that category.</p>}
        </div>
        {data.counters.length > 0 && f.numbering === 'PER_PREFIX' && (
          <div className="mt-4">
            <div className="field-label">Running numbers in use</div>
            <div className="flex flex-wrap gap-2 text-xs">{data.counters.map((c) => <span key={c.prefix} className="rounded bg-slate-100 px-2 py-1 font-mono">{c.prefix}… next {c.nextValue}</span>)}</div>
          </div>
        )}
        <ErrorBox error={errF} className="mt-3" />
      </Card>

      <Card title="QR labels" actions={<button className="btn btn-sm btn-primary" disabled={busy === 'l'} onClick={saveLabels}>{busy === 'l' && <Spinner className="h-3 w-3" />}Save labels</button>}>
        <fieldset>
          <legend className="field-label">What the QR code holds</legend>
          <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={l.qrContent === 'ASSET_ID'} onChange={() => setL({ ...l, qrContent: 'ASSET_ID' })} />
            <span>The Asset ID only <span className="block text-xs text-slate-500">Works with any scanner and never goes out of date. Scan it with Scan asset, a USB scanner in the search box, or during a campaign.</span></span></label>
          <label className="mt-2 flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={l.qrContent === 'LINK'} onChange={() => setL({ ...l, qrContent: 'LINK' })} />
            <span>A link to the asset <span className="block text-xs text-slate-500">A phone&apos;s own camera opens the asset after sign-in: <span className="font-mono">{data.appUrl.replace(/\/+$/, '')}/scan/AST-000001</span>. Labels stop opening from a phone camera if this address changes, but still scan inside the app.</span></span></label>
        </fieldset>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={l.barcode} onChange={(e) => setL({ ...l, barcode: e.target.checked })} />
          <span>Also print a barcode (Code 128) of the Asset ID under the QR code
            <span className="block text-xs text-slate-500">For handheld laser or 1D barcode scanners, which cannot read QR codes. The QR code is always printed.</span></span>
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Default layout">
            <select className="input" value={l.layout} onChange={(e) => setL({ ...l, layout: e.target.value as LabelSettings['layout'] })}>
              <option value="A4_SHEET">A4 sheet, 24 labels (3 × 8)</option>
              <option value="LABEL_PRINTER">Label printer, one label per page</option>
            </select>
          </Field>
          <Field label="Label width (mm)" hint="Label printer only."><input className="input" type="number" min={25} max={150} value={l.labelWidthMm} onChange={(e) => setL({ ...l, labelWidthMm: Number(e.target.value) })} /></Field>
          <Field label="Label height (mm)" hint="Label printer only."><input className="input" type="number" min={15} max={100} value={l.labelHeightMm} onChange={(e) => setL({ ...l, labelHeightMm: Number(e.target.value) })} /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Labels at least 1.5 times as wide as they are high show the branch, make, model and serial beside the QR code; narrower labels show only the Asset ID under it. The layout can also be chosen each time labels are printed.</p>
        <ErrorBox error={errL} className="mt-3" />
      </Card>
    </div>
  );
}
