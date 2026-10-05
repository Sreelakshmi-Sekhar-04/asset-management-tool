import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { scanPath, type LabelSettings } from '@/lib/asset-code';
import { code128Widths } from '@/lib/code128';
import { layoutLabel, MM } from '@/lib/label-layout';
import { badRequest, notFound } from '@/lib/errors';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { label, LINE_STATUS_LABEL, TRANSFER_STATUS_LABEL } from '@/lib/labels';
import type { Actor } from './actor';
import { audit } from './audit';
import { assetScope } from './scope';
import { getSettings } from './settings';
import { getTransfer } from './services/transfers';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * FR-TRF-13: printable transfer note. Carries the transfer number, both locations,
 * reason, requester, approver, per-line dispatch and receipt status, Asset IDs,
 * serials, make/model, signature blocks and — for inter-state transfers — the
 * optional invoice reference. No value or tax is computed.
 */
export async function transferNotePdf(actor: Actor, id: string) {
  const tr = await getTransfer(actor, id); // scope enforced
  const lines = await prisma.transferLine.findMany({ where: { transferId: tr.id }, orderBy: { assetCode: 'asc' } });
  const settings = await getSettings();
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Transfer note ${tr.transferNo}`, Author: settings.orgName } });
  const W = doc.page.width - 80;

  doc.font('Helvetica-Bold').fontSize(16).text(settings.orgName, { align: 'left' });
  doc.font('Helvetica').fontSize(11).fillColor('#444').text('Asset transfer note');
  doc.moveDown(0.5).fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(14).text(tr.transferNo, { continued: true }).font('Helvetica').fontSize(10).text(`   ${label(TRANSFER_STATUS_LABEL, tr.status)}${tr.interState ? '  ·  Inter-state' : ''}${tr.recordedLate ? '  ·  Recorded late' : ''}`);
  doc.moveDown(0.5);

  const kv: [string, string][] = [
    ['From', tr.fromLocation.namePath], ['To', tr.toLocation.namePath], ['Reason', tr.reason ?? '—'],
    ['Requested by', `${tr.requestedByName} on ${fmtDateOnly(tr.requestedAt)}`], ['Effective date', tr.effectiveDate ? fmtDateOnly(tr.effectiveDate) : '—'],
    ['Approved by', tr.approverNames ?? (tr.approvedAt ? 'Auto-approved' : '—')], ['Dispatched', tr.approvedAt ? fmtDateTime(tr.approvedAt) : '—'],
    ['Completed', tr.completedAt ? fmtDateTime(tr.completedAt) : '—'], ['Lines', `${tr.counts.total} sent · ${tr.counts.received} received · ${tr.counts.rejected} not received · ${tr.counts.recalled} recalled · ${tr.counts.pending} outstanding`],
  ];
  if (tr.interState) kv.push(['Invoice number', tr.invoiceNumber ?? '—']);
  if (tr.sdpTicketId || tr.sdpTicketUrl) kv.push(['SDP ticket', [tr.sdpTicketId, tr.sdpTicketUrl].filter(Boolean).join(' ')]);
  doc.fontSize(9.5);
  for (const [k, v] of kv) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(k, 40, y, { width: 100 });
    doc.font('Helvetica').text(v, 145, y, { width: W - 105 });
    doc.moveDown(0.15);
  }
  doc.moveDown(0.6);

  const cols = [
    { h: '#', w: 22 }, { h: 'Asset ID', w: 70 }, { h: 'Serial', w: 95 }, { h: 'Make / model', w: 140 }, { h: 'Dispatch', w: 60 }, { h: 'Receipt', w: 70 }, { h: 'Received by / reason', w: W - 457 },
  ];
  const header = () => {
    const y = doc.y;
    doc.rect(40, y - 2, W, 16).fill('#eef2f7').fillColor('#000').font('Helvetica-Bold').fontSize(8.5);
    let x = 40;
    for (const c of cols) { doc.text(c.h, x + 2, y + 2, { width: c.w - 4 }); x += c.w; }
    doc.y = y + 16;
  };
  header();
  doc.font('Helvetica').fontSize(8.5);
  lines.forEach((l, i) => {
    const cells = [
      String(i + 1), l.assetCode, l.serialNumber ?? '—', `${l.make} ${l.model}`, tr.approvedAt ? 'Dispatched' : 'Not dispatched',
      label(LINE_STATUS_LABEL, l.status), l.status === 'NOT_RECEIVED' ? l.rejectReason ?? '' : l.receivedByName ?? '',
    ];
    const h = Math.max(...cells.map((c, j) => doc.heightOfString(c, { width: cols[j].w - 4 }))) + 4;
    if (doc.y + h > doc.page.height - 150) { doc.addPage(); header(); doc.font('Helvetica').fontSize(8.5); }
    const y = doc.y;
    let x = 40;
    cells.forEach((c, j) => { doc.text(c, x + 2, y + 2, { width: cols[j].w - 4 }); x += cols[j].w; });
    doc.moveTo(40, y + h).lineTo(40 + W, y + h).strokeColor('#dde3ea').stroke();
    doc.y = y + h;
  });

  if (doc.y > doc.page.height - 150) doc.addPage();
  doc.moveDown(2);
  const sy = doc.y;
  const bw = (W - 40) / 3;
  ['Dispatched by (sender)', 'Carried by', 'Received by (receiver)'].forEach((t, i) => {
    const x = 40 + i * (bw + 20);
    doc.moveTo(x, sy + 40).lineTo(x + bw, sy + 40).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).text(t, x, sy + 44, { width: bw });
    doc.font('Helvetica').text('Name, signature and date', x, sy + 56, { width: bw });
  });
  doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(`Generated ${fmtDateTime(new Date())} by ${actor.name}. This note carries no value or tax computation.`, 40, doc.page.height - 55, { width: W, align: 'center' });

  const data = await toBuffer(doc);
  await audit(prisma, actor, { action: 'TRANSFER_NOTE_GENERATED', entityType: 'Transfer', entityId: tr.id, entityLabel: tr.transferNo, locationIds: [tr.fromLocationId, tr.toLocationId] });
  return { data, mime: 'application/pdf', file: `${tr.transferNo}.pdf` };
}

/** What the QR code on a label holds: the bare Asset ID, or a link that opens the asset. */
export function qrPayload(assetCode: string, labels: LabelSettings) {
  return labels.qrContent === 'LINK' ? `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}${scanPath(assetCode)}` : assetCode;
}

type LabelAsset = { assetCode: string; make: string; model: string; serialNumber: string | null; location: { name: string } | null };

/** Draws one label in the box; positions come from layoutLabel(), which the print preview also uses. */
async function drawLabel(doc: PDFKit.PDFDocument, a: LabelAsset, box: { x: number; y: number; w: number; h: number }, labels: LabelSettings, orgName: string) {
  const measure = (t: string, size: number, bold: boolean) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).widthOfString(t);
  const content = { assetCode: a.assetCode, location: a.location?.name ?? null, makeModel: `${a.make} ${a.model}`, serial: a.serialNumber, orgName };
  for (const el of layoutLabel(box.w, box.h, content, { barcode: labels.barcode }, measure)) {
    if (el.kind === 'qr') {
      const qr = await QRCode.toBuffer(qrPayload(a.assetCode, labels), { errorCorrectionLevel: 'M', margin: 1, width: 300 });
      doc.image(qr, box.x + el.x, box.y + el.y, { width: el.size, height: el.size });
    } else if (el.kind === 'barcode') {
      // Code 128 of the bare Asset ID, with a quiet zone of 10 modules each side.
      const widths = code128Widths(a.assetCode);
      const modules = widths.reduce((n, x) => n + x, 0) + 20;
      const m = el.w / modules;
      let x = box.x + el.x + m * 10;
      doc.fillColor('#000');
      widths.forEach((wd, i) => { if (i % 2 === 0) doc.rect(x, box.y + el.y, wd * m, el.h).fill(); x += wd * m; });
    } else {
      doc.font(el.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(el.size).fillColor(el.color)
        .text(el.text, box.x + el.x, box.y + el.y, { width: el.w, align: el.align, lineBreak: false, height: el.size * 1.2, ellipsis: true });
    }
  }
}

export const labelsInput = z.object({
  assetIds: z.array(z.string()).min(1, 'Select at least one asset.').max(2000, 'At most 2,000 labels per batch.'),
  /** Overrides the configured layout for this print run. */
  layout: z.enum(['A4_SHEET', 'LABEL_PRINTER']).optional(),
  /** A4 sheet only: leave this many label positions empty, to reuse a partly used sheet. */
  skip: z.number().int().min(0).max(23).optional(),
});

/**
 * FR-REG-10: printable labels, single or batch. Each carries a QR code for the Asset ID
 * (or a link to it, per the label settings), the human-readable Asset ID and the branch.
 * A4 sheet (3 × 8) or one label per page for a label printer.
 */
export async function labelsPdf(actor: Actor, input: unknown) {
  const d = labelsInput.parse(input);
  const assets = await prisma.asset.findMany({
    where: { AND: [assetScope(actor), { OR: [{ id: { in: d.assetIds } }, { assetCode: { in: d.assetIds.map((x) => x.toUpperCase()) } }] }] },
    select: { id: true, assetCode: true, make: true, model: true, serialNumber: true, location: { select: { name: true, namePath: true } } },
    orderBy: { assetCode: 'asc' },
  });
  if (!assets.length) throw badRequest('None of the selected assets are within your scope.');
  const settings = await getSettings();
  const labels = settings.labels;
  const layout = d.layout ?? labels.layout;
  let doc: PDFKit.PDFDocument;
  if (layout === 'LABEL_PRINTER') {
    const size: [number, number] = [labels.labelWidthMm * MM, labels.labelHeightMm * MM];
    doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, info: { Title: 'Asset labels', Author: settings.orgName } });
    for (const a of assets) {
      doc.addPage({ size, margin: 0 });
      await drawLabel(doc, a, { x: 0, y: 0, w: size[0], h: size[1] }, labels, settings.orgName);
    }
  } else {
    doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Asset labels', Author: settings.orgName } });
    const cols = 3, rows = 8, mx = 20, my = 25, per = cols * rows;
    const lw = (doc.page.width - mx * 2) / cols, lh = (doc.page.height - my * 2) / rows;
    const skip = d.skip ?? 0;
    for (let i = 0; i < assets.length; i++) {
      const slot = i + skip;
      if (i > 0 && slot % per === 0) doc.addPage();
      const k = slot % per;
      const x = mx + (k % cols) * lw, y = my + Math.floor(k / cols) * lh;
      doc.rect(x + 3, y + 3, lw - 6, lh - 6).lineWidth(0.4).strokeColor('#bbb').stroke();
      await drawLabel(doc, assets[i], { x: x + 3, y: y + 3, w: lw - 6, h: lh - 6 }, labels, settings.orgName);
    }
  }
  const data = await toBuffer(doc);
  await audit(prisma, actor, { action: 'LABELS_GENERATED', entityType: 'Asset', entityId: assets.length === 1 ? assets[0].id : undefined, entityLabel: assets.length === 1 ? assets[0].assetCode : `${assets.length} label(s)`, details: { assets: assets.slice(0, 200).map((a) => a.assetCode), count: assets.length, layout } });
  return { data, mime: 'application/pdf', file: assets.length === 1 ? `label-${assets[0].assetCode}.pdf` : `asset-labels-${new Date().toISOString().slice(0, 10)}.pdf`, count: assets.length };
}

/** The QR code for one asset, as SVG (for the screen) or PNG (to download). Scope enforced. */
export async function assetQr(actor: Actor, id: string, format: 'svg' | 'png') {
  const a = await prisma.asset.findFirst({ where: { AND: [assetScope(actor), { OR: [{ id }, { assetCode: id.toUpperCase() }] }] }, select: { assetCode: true } });
  if (!a) throw notFound('Asset');
  const payload = qrPayload(a.assetCode, (await getSettings()).labels);
  if (format === 'png') return { data: await QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 2, width: 600 }), mime: 'image/png', file: `qr-${a.assetCode}.png`, payload };
  return { data: Buffer.from(await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })), mime: 'image/svg+xml', file: `qr-${a.assetCode}.svg`, payload };
}
