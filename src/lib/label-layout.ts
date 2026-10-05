/**
 * Where everything sits on one asset label. Shared by the PDF (server) and the print
 * preview (browser) so the preview shows exactly what prints. Units are PDF points.
 */

export interface LabelContent { assetCode: string; location: string | null; makeModel: string; serial: string | null; orgName: string }

export type LabelElement =
  | { kind: 'qr'; x: number; y: number; size: number }
  | { kind: 'barcode'; x: number; y: number; w: number; h: number }
  | { kind: 'text'; x: number; y: number; w: number; size: number; bold: boolean; color: string; text: string; align: 'left' | 'center' };

/** Width of a string at a font size; the PDF and the browser each measure with their own font engine. */
export type Measure = (text: string, size: number, bold: boolean) => number;

export const MM = 72 / 25.4;

function fit(measure: Measure, text: string, bold: boolean, max: number, width: number) {
  let size = max;
  while (size > 5 && measure(text, size, bold) > width) size -= 0.5;
  return size;
}

/**
 * Wide labels: QR on the left, Asset ID and details on the right. Narrow or square labels:
 * QR with the Asset ID under it. With a barcode, a Code 128 strip of the Asset ID runs along
 * the bottom at full width, so 1D scanners can read it at normal module sizes.
 */
export function layoutLabel(w: number, h: number, c: LabelContent, opts: { barcode: boolean }, measure: Measure): LabelElement[] {
  const out: LabelElement[] = [];
  const pad = Math.max(3, Math.min(w, h) * 0.06);
  const barH = opts.barcode ? Math.max(10, h * 0.22) : 0;
  const gap = opts.barcode ? Math.max(2, pad * 0.5) : 0;
  const top = h - pad * 2 - barH - gap; // height of the QR / text area
  if (opts.barcode) out.push({ kind: 'barcode', x: pad, y: h - pad - barH, w: w - pad * 2, h: barH });

  if (w / (top + pad * 2) < 1.5) {
    const idH = Math.max(7, top * 0.16);
    const q = Math.min(w - pad * 2, top - idH - 1);
    out.push({ kind: 'qr', x: (w - q) / 2, y: pad, size: q });
    out.push({ kind: 'text', x: pad, y: pad + q + 1, w: w - pad * 2, size: fit(measure, c.assetCode, true, idH, w - pad * 2), bold: true, color: '#000', text: c.assetCode, align: 'center' });
    return out;
  }

  const q = top;
  out.push({ kind: 'qr', x: pad, y: pad, size: q });
  const tx = pad * 2 + q, tw = w - q - pad * 3;
  const idSize = fit(measure, c.assetCode, true, Math.min(14, top * 0.26), tw);
  out.push({ kind: 'text', x: tx, y: pad, w: tw, size: idSize, bold: true, color: '#000', text: c.assetCode, align: 'left' });
  let y = pad + idSize * 1.3;
  const small = Math.max(5, Math.min(7.5, top * 0.15));
  const bottom = pad + top;
  const orgSize = Math.max(5, small - 1);
  for (const line of [c.location ?? '', c.makeModel, c.serial ? `S/N ${c.serial}` : ''].filter(Boolean)) {
    if (y + small * 1.2 > bottom - orgSize * 1.3) break;
    out.push({ kind: 'text', x: tx, y, w: tw, size: Math.min(small, fit(measure, line, false, small, tw)), bold: false, color: '#333', text: line, align: 'left' });
    y += small * 1.25;
  }
  if (y <= bottom - orgSize * 1.3) out.push({ kind: 'text', x: tx, y: bottom - orgSize * 1.2, w: tw, size: orgSize, bold: false, color: '#777', text: c.orgName, align: 'left' });
  return out;
}

/** A4 sheet geometry: 3 × 8 labels with the same margins as the PDF. */
export const A4 = { w: 595.28, h: 841.89, cols: 3, rows: 8, mx: 20, my: 25 };
export const sheetLabelSize = () => ({ w: (A4.w - A4.mx * 2) / A4.cols - 6, h: (A4.h - A4.my * 2) / A4.rows - 6 });
