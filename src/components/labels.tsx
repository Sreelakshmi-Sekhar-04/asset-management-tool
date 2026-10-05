'use client';
import { useEffect, useState } from 'react';
import type { LabelSettings } from '@/lib/asset-code';
import { openFile, useApi } from './api';
import { Field, FormModal, Spinner, useToast } from './ui';

export const useLabelSettings = () => useApi<{ labels: LabelSettings }>('/api/settings/public').data?.labels;

const layoutText = (l: LabelSettings | undefined, layout: LabelSettings['layout']) =>
  layout === 'A4_SHEET' ? 'A4 sheet, 24 labels (3 × 8)' : `Label printer, ${l?.labelWidthMm ?? 50} × ${l?.labelHeightMm ?? 25} mm`;

/** Opens the labels PDF in a new tab: the browser's viewer is the print preview. */
export async function printLabels(assetIds: string[], opts: { layout?: LabelSettings['layout']; skip?: number } = {}) {
  await openFile('/api/assets/labels?inline=1', { assetIds, ...opts });
}

/** Print-labels dialog for one or many assets: choose the layout and, on a sheet, where to start. */
export function PrintLabelsDialog({ open, onClose, assetIds, title }: { open: boolean; onClose: () => void; assetIds: string[]; title?: string }) {
  const settings = useLabelSettings();
  const [layout, setLayout] = useState<LabelSettings['layout']>('A4_SHEET');
  const [skip, setSkip] = useState(0);
  useEffect(() => { if (open && settings) { setLayout(settings.layout); setSkip(0); } }, [open, settings]);
  const n = assetIds.length;
  return (
    <FormModal open={open} onClose={onClose} title={title ?? `Print ${n} label${n === 1 ? '' : 's'}`} submitLabel="Preview and print" disabled={!settings || n === 0}
      onSubmit={() => printLabels(assetIds, { layout, skip: layout === 'A4_SHEET' && skip > 0 ? skip : undefined })}>
      {!settings ? <Spinner /> : <>
        <Field label="Layout">
          <select className="input" value={layout} onChange={(e) => setLayout(e.target.value as LabelSettings['layout'])}>
            <option value="A4_SHEET">{layoutText(settings, 'A4_SHEET')}</option>
            <option value="LABEL_PRINTER">{layoutText(settings, 'LABEL_PRINTER')}</option>
          </select>
        </Field>
        {layout === 'A4_SHEET' && (
          <Field label="Start at label position" hint="To reuse a partly used sheet: positions count left to right, top to bottom.">
            <input className="input" type="number" min={1} max={24} value={skip + 1} onChange={(e) => setSkip(Math.min(23, Math.max(0, Number(e.target.value) - 1 || 0)))} />
          </Field>
        )}
        <p className="text-xs text-slate-500">
          Each label shows the QR code, the Asset ID{layout === 'A4_SHEET' || (settings.labelWidthMm / settings.labelHeightMm) >= 1.5 ? ', branch, make and model, and serial number' : ' under the code'}.
          The PDF opens in a new tab; print it at 100% (actual size).
        </p>
      </>}
    </FormModal>
  );
}

/** QR code card for the asset page: preview, download and print. */
export function AssetQrCard({ id, assetCode, onPrint }: { id: string; assetCode: string; onPrint: () => void }) {
  const toast = useToast();
  const settings = useLabelSettings();
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded border bg-white p-1">
        {failed ? <span className="px-2 text-center text-xs text-slate-500">QR code could not be shown. Reload the page to try again.</span>
          // eslint-disable-next-line @next/next/no-img-element -- authenticated, uncacheable SVG from our own API
          : <img src={`/api/assets/${id}/qr?format=svg`} alt={`QR code for ${assetCode}`} className="h-full w-full" onError={() => setFailed(true)} />}
      </div>
      <div className="min-w-0 space-y-2 text-center sm:text-left">
        <div className="font-mono text-lg font-semibold">{assetCode}</div>
        <p className="text-xs text-slate-500">
          {settings?.qrContent === 'LINK' ? 'The code holds a link to this asset, so a phone camera opens it directly. ' : 'The code holds the Asset ID. '}
          Scan it with the asset scanner, a USB scanner in the search box, or during verification.
        </p>
        <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
          <button className="btn btn-sm btn-primary" onClick={onPrint}>Print label</button>
          <a className="btn btn-sm" href={`/api/assets/${id}/qr?format=png&download=1`} download onClick={(e) => { if (failed) { e.preventDefault(); toast('The QR code is unavailable right now.', 'err'); } }}>Download QR (PNG)</a>
        </div>
      </div>
    </div>
  );
}
