import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '@/lib/db';
import { badRequest } from '@/lib/errors';
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

/**
 * FR-REG-10: printable labels, single or batch. Each carries a QR code encoding the
 * Asset ID, plus the human-readable ID and branch. A4 sheet, 3 × 8 labels.
 */
export async function labelsPdf(actor: Actor, assetIds: string[]) {
  if (!assetIds.length) throw badRequest('Select at least one asset.');
  if (assetIds.length > 2000) throw badRequest('At most 2,000 labels per batch.');
  const assets = await prisma.asset.findMany({
    where: { AND: [assetScope(actor), { OR: [{ id: { in: assetIds } }, { assetCode: { in: assetIds.map((x) => x.toUpperCase()) } }] }] },
    select: { id: true, assetCode: true, make: true, model: true, serialNumber: true, location: { select: { name: true, namePath: true } } },
    orderBy: { assetCode: 'asc' },
  });
  if (!assets.length) throw badRequest('None of the selected assets are within your scope.');
  const settings = await getSettings();
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Asset labels', Author: settings.orgName } });
  const cols = 3, rows = 8, mx = 20, my = 25;
  const lw = (doc.page.width - mx * 2) / cols, lh = (doc.page.height - my * 2) / rows;
  for (let i = 0; i < assets.length; i++) {
    if (i > 0 && i % (cols * rows) === 0) doc.addPage();
    const a = assets[i];
    const k = i % (cols * rows);
    const x = mx + (k % cols) * lw, y = my + Math.floor(k / cols) * lh;
    doc.rect(x + 3, y + 3, lw - 6, lh - 6).lineWidth(0.4).strokeColor('#bbb').stroke();
    const qr = await QRCode.toBuffer(a.assetCode, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    const q = lh - 20;
    doc.image(qr, x + 8, y + 10, { width: q, height: q });
    const tx = x + 14 + q, tw = lw - q - 24;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text(a.assetCode, tx, y + 12, { width: tw });
    doc.font('Helvetica').fontSize(7.5).text(a.location?.name ?? '', tx, y + 30, { width: tw, height: 20, ellipsis: true });
    doc.fontSize(6.5).fillColor('#444').text(`${a.make} ${a.model}`, tx, y + 52, { width: tw, height: 16, ellipsis: true });
    if (a.serialNumber) doc.text(`S/N ${a.serialNumber}`, tx, y + 68, { width: tw, height: 9, ellipsis: true });
    doc.fontSize(6).fillColor('#777').text(settings.orgName, tx, y + lh - 20, { width: tw, height: 9, ellipsis: true });
  }
  const data = await toBuffer(doc);
  await audit(prisma, actor, { action: 'LABELS_GENERATED', entityType: 'Asset', entityLabel: `${assets.length} label(s)`, details: { assets: assets.slice(0, 200).map((a) => a.assetCode), count: assets.length } });
  return { data, mime: 'application/pdf', file: `asset-labels-${new Date().toISOString().slice(0, 10)}.pdf`, count: assets.length };
}
