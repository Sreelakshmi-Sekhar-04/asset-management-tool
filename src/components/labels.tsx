'use client';
import { useEffect, useMemo, useState } from 'react';
import type { LabelSettings } from '@/lib/asset-code';
import { code128Widths } from '@/lib/code128';
import { A4, layoutLabel, MM, sheetLabelSize, type LabelContent } from '@/lib/label-layout';
import { openFile, useApi } from './api';
import { useMe } from './me';
import { Field, FormModal, Spinner, useToast } from './ui';

export const useLabelSettings = () => useApi<{ labels: LabelSettings }>('/api/settings/public').data?.labels;

const layoutText = (l: LabelSettings | undefined, layout: LabelSettings['layout']) =>
  layout === 'A4_SHEET' ? 'A4 sheet, 24 labels (3 × 8)' : `Label printer, ${l?.labelWidthMm ?? 50} × ${l?.labelHeightMm ?? 25} mm`;

/** Opens the labels PDF in a new tab: the browser's viewer is the print preview. */
export async function printLabels(assetIds: string[], opts: { layout?: LabelSettings['layout']; skip?: number } = {}) {
  await openFile('/api/assets/labels?inline=1', { assetIds, ...opts });
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Text width in the browser, with Helvetica metrics where available (Arial is metric-compatible). */
function measure(text: string, size: number, bold: boolean) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.55;
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

/** One label drawn to scale from the same layout the PDF uses. */
export function LabelPreview({ assetId, content, w, h, barcode, maxWidth = 340 }: { assetId: string; content: LabelContent; w: number; h: number; barcode: boolean; maxWidth?: number }) {
  const els = useMemo(() => layoutLabel(w, h, content, { barcode }, measure), [w, h, content, barcode]);
  const scale = Math.min(maxWidth / w, 220 / h);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w * scale} height={h * scale} className="rounded border border-slate-300 bg-white shadow-sm" role="img" aria-label={`Label preview for ${content.assetCode}`}>
      {els.map((el, i) => {
        if (el.kind === 'qr') return <image key={i} href={`/api/assets/${assetId}/qr?format=svg`} x={el.x} y={el.y} width={el.size} height={el.size} />;
        if (el.kind === 'barcode') {
          const widths = code128Widths(content.assetCode);
          const m = el.w / (widths.reduce((n, x) => n + x, 0) + 20);
          let x = el.x + m * 10;
          return <g key={i}>{widths.map((wd, j) => { const r = j % 2 === 0 ? <rect key={j} x={x} y={el.y} width={wd * m} height={el.h} fill="#000" /> : null; x += wd * m; return r; })}</g>;
        }
        return (
          <text key={i} x={el.align === 'center' ? el.x + el.w / 2 : el.x} y={el.y + el.size * 0.85} fontSize={el.size} fontWeight={el.bold ? 700 : 400} fill={el.color}
            textAnchor={el.align === 'center' ? 'middle' : 'start'} fontFamily="Helvetica, Arial, sans-serif"
            {...(measure(el.text, el.size, el.bold) > el.w ? { textLength: el.w, lengthAdjust: 'spacingAndGlyphs' } : {})}>{el.text}</text>
        );
      })}
    </svg>
  );
}

/** Where the labels land on the first A4 sheet: skipped positions grey, printed ones blue. */
function SheetMap({ skip, count }: { skip: number; count: number }) {
  const per = A4.cols * A4.rows;
  return (
    <div className="grid w-24 shrink-0 grid-cols-3 gap-0.5 rounded border border-slate-300 bg-white p-1" aria-label="Positions on the first sheet">
      {Array.from({ length: per }, (_, i) => (
        <div key={i} className={`h-2.5 rounded-sm ${i < skip ? 'bg-slate-200' : i < skip + count ? 'bg-brand-600' : 'border border-slate-200'}`} />
      ))}
    </div>
  );
}

interface PreviewAsset { assetCode: string; location: string | null; make: string; model: string; serialNumber: string | null }

/** Print-labels dialog for one or many assets: choose the stock, see the label, then print. */
export function PrintLabelsDialog({ open, onClose, assetIds, title }: { open: boolean; onClose: () => void; assetIds: string[]; title?: string }) {
  const me = useMe();
  const settings = useLabelSettings();
  const [layout, setLayout] = useState<LabelSettings['layout']>('A4_SHEET');
  const [skip, setSkip] = useState(0);
  const first = useApi<PreviewAsset>(open && assetIds[0] ? `/api/assets/${assetIds[0]}` : null, [open, assetIds[0]]);
  useEffect(() => { if (open && settings) { setLayout(settings.layout); setSkip(0); } }, [open, settings]);
  const n = assetIds.length;
  const content = useMemo<LabelContent | null>(() => first.data ? {
    assetCode: first.data.assetCode, location: first.data.location?.split(' / ').pop() ?? null,
    makeModel: `${first.data.make} ${first.data.model}`, serial: first.data.serialNumber, orgName: me.orgName,
  } : null, [first.data, me.orgName]);
  const size = layout === 'A4_SHEET' ? sheetLabelSize() : { w: (settings?.labelWidthMm ?? 50) * MM, h: (settings?.labelHeightMm ?? 25) * MM };
  const mm = (pt: number) => Math.round(pt / MM);
  return (
    <FormModal open={open} onClose={onClose} title={title ?? `Print ${n} label${n === 1 ? '' : 's'}`} submitLabel="Open to print" disabled={!settings || n === 0}
      onSubmit={() => printLabels(assetIds, { layout, skip: layout === 'A4_SHEET' && skip > 0 ? skip : undefined })}>
      {!settings ? <Spinner /> : <>
        <Field label="Label stock">
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
        <div>
          <div className="field-label">Preview{n > 1 ? ` (first of ${n} labels)` : ''} · {mm(size.w)} × {mm(size.h)} mm</div>
          <div className="flex items-start gap-3 rounded-md bg-slate-100 p-3">
            {content && first.data ? <LabelPreview assetId={assetIds[0]} content={content} w={size.w} h={size.h} barcode={settings.barcode} /> : first.error ? <p className="text-xs text-slate-500">Preview unavailable.</p> : <Spinner />}
            {layout === 'A4_SHEET' && <SheetMap skip={skip} count={n} />}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            The QR code opens the asset from the scanner or a phone camera{settings.barcode ? '; the barcode underneath holds the same Asset ID for handheld barcode scanners' : ''}.
            The PDF opens in a new tab; print at 100% (actual size).
          </p>
        </div>
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
          Scan it with the asset scanner, a USB scanner in the search box, or during a campaign.
        </p>
        <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
          <button className="btn btn-sm btn-primary" onClick={onPrint}>Print label</button>
          <a className="btn btn-sm" href={`/api/assets/${id}/qr?format=png&download=1`} download onClick={(e) => { if (failed) { e.preventDefault(); toast('The QR code is unavailable right now.', 'err'); } }}>Download QR (PNG)</a>
        </div>
      </div>
    </div>
  );
}
