import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { label, LINE_STATUS_LABEL, TRANSFER_STATUS_LABEL } from '@/lib/labels';
import type { Actor } from './actor';
import { audit } from './audit';
import { assetScope, getScopedAsset } from './scope';
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

export const LABEL_LAYOUTS = ['A4', 'THERMAL_50x25'] as const;
export type LabelLayout = (typeof LABEL_LAYOUTS)[number];
const MM = 72 / 25.4;

/**
 * FR-REG-10: printable labels, single or batch. Each carries a QR code encoding only the
 * Asset ID (so labels stay valid if details change), plus the human-readable ID.
 * A4: sheet of 3 × 8 labels for office printers. THERMAL_50x25: one 50 × 25 mm label
 * per page for thermal label printers.
 */
export async function labelsPdf(actor: Actor, assetIds: string[], layout: LabelLayout = 'A4') {
  if (!assetIds.length) throw badRequest('Select at least one asset.');
  if (assetIds.length > 2000) throw badRequest('At most 2,000 labels per batch.');
  const assets = await prisma.asset.findMany({
    where: { AND: [assetScope(actor), { OR: [{ id: { in: assetIds } }, { assetCode: { in: assetIds.map((x) => x.toUpperCase()) } }] }] },
    select: { id: true, assetCode: true, make: true, model: true, serialNumber: true, location: { select: { name: true, namePath: true } } },
    orderBy: { assetCode: 'asc' },
  });
  if (!assets.length) throw badRequest('None of the selected assets are within your scope.');
  const settings = await getSettings();
  const qrOf = (code: string) => QRCode.toBuffer(code, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  let doc: PDFKit.PDFDocument;
  if (layout === 'THERMAL_50x25') {
    const W = 50 * MM, H = 25 * MM, pad = 2 * MM;
    doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: 'Asset labels', Author: settings.orgName } });
    for (const a of assets) {
      doc.addPage({ size: [W, H], margin: 0 });
      const q = H - pad * 2;
      doc.image(await qrOf(a.assetCode), pad, pad, { width: q, height: q });
      const tx = pad * 2 + q, tw = W - tx - pad;
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8.5).text(a.assetCode, tx, pad + 1, { width: tw, lineBreak: true, height: 22 });
      doc.font('Helvetica').fontSize(5.5).fillColor('#222').text(`${a.make} ${a.model}`, tx, pad + 24, { width: tw, height: 14, ellipsis: true });
      if (a.serialNumber) doc.text(`S/N ${a.serialNumber}`, tx, pad + 38, { width: tw, height: 7, ellipsis: true, lineBreak: false });
      doc.fontSize(5).fillColor('#555').text(settings.orgName, tx, H - pad - 6, { width: tw, height: 6, ellipsis: true, lineBreak: false });
    }
  } else {
    doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Asset labels', Author: settings.orgName } });
    const cols = 3, rows = 8, mx = 20, my = 25;
    const lw = (doc.page.width - mx * 2) / cols, lh = (doc.page.height - my * 2) / rows;
    for (let i = 0; i < assets.length; i++) {
      if (i > 0 && i % (cols * rows) === 0) doc.addPage();
      const a = assets[i];
      const k = i % (cols * rows);
      const x = mx + (k % cols) * lw, y = my + Math.floor(k / cols) * lh;
      doc.rect(x + 3, y + 3, lw - 6, lh - 6).lineWidth(0.4).strokeColor('#bbb').stroke();
      const q = lh - 20;
      doc.image(await qrOf(a.assetCode), x + 8, y + 10, { width: q, height: q });
      const tx = x + 14 + q, tw = lw - q - 24;
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text(a.assetCode, tx, y + 12, { width: tw });
      doc.font('Helvetica').fontSize(7.5).text(a.location?.name ?? '', tx, y + 30, { width: tw, height: 20, ellipsis: true });
      doc.fontSize(6.5).fillColor('#444').text(`${a.make} ${a.model}`, tx, y + 52, { width: tw, height: 16, ellipsis: true });
      if (a.serialNumber) doc.text(`S/N ${a.serialNumber}`, tx, y + 68, { width: tw, height: 9, ellipsis: true });
      doc.fontSize(6).fillColor('#777').text(settings.orgName, tx, y + lh - 20, { width: tw, height: 9, ellipsis: true });
    }
  }
  const data = await toBuffer(doc);
  await audit(prisma, actor, { action: 'LABELS_GENERATED', entityType: 'Asset', entityLabel: `${assets.length} label(s)`, details: { assets: assets.slice(0, 200).map((a) => a.assetCode), count: assets.length, layout } });
  const file = assets.length === 1 ? `label-${assets[0].assetCode.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` : `asset-labels-${new Date().toISOString().slice(0, 10)}.pdf`;
  return { data, mime: 'application/pdf', file, count: assets.length };
}

/** QR code (SVG) for one asset, encoding its Asset ID — the same content as the printed label. */
export async function assetQrSvg(actor: Actor, idOrCode: string) {
  const a = await getScopedAsset(actor, idOrCode);
  const svg = await QRCode.toString(a.assetCode, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  return { data: Buffer.from(svg), mime: 'image/svg+xml', file: `qr-${a.assetCode.replace(/[^A-Za-z0-9._-]/g, '_')}.svg` };
}
