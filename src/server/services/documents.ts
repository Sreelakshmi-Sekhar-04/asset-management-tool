import crypto from 'node:crypto';
import path from 'node:path';
import type { DocumentEntity } from '@prisma/client';
import { prisma, tx } from '@/lib/db';
import { AppError, badRequest, forbidden, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit } from '../audit';
import { assetScope, inScopePath, transferScope } from '../scope';
import { getSettings } from '../settings';
import { getObject, newKey, putObject, deleteObject } from '../storage';
import { scanBuffer } from '../virus-scan';

// Magic-number checks so the declared type cannot be spoofed by the file extension alone.
function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // docx/xlsx/pptx
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole'; // doc/xls/ppt
  return null;
}

const EXT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.csv': 'text/csv',
};

/** Resolve the owning record and enforce scope (FR-DOC-05). Returns location ids for the audit trail. */
export async function assertRecordAccess(actor: Actor, entityType: DocumentEntity, entityId: string, write: boolean): Promise<string[]> {
  switch (entityType) {
    case 'ASSET': {
      const a = await prisma.asset.findFirst({ where: { AND: [{ id: entityId }, assetScope(actor)] }, select: { locationId: true } });
      if (!a) throw notFound('Record');
      return [a.locationId!];
    }
    case 'TRANSFER': {
      const t = await prisma.transfer.findFirst({ where: { AND: [{ id: entityId }, transferScope(actor)] }, select: { fromLocationId: true, toLocationId: true } });
      if (!t) throw notFound('Record');
      return [t.fromLocationId, t.toLocationId];
    }
    case 'TRANSFER_RECEIPT': {
      const r = await prisma.transferReceipt.findUnique({ where: { id: entityId }, include: { transfer: { include: { fromLocation: true, toLocation: true } } } });
      if (!r || !(inScopePath(actor, r.transfer.fromLocation.idPath) || inScopePath(actor, r.transfer.toLocation.idPath))) throw notFound('Record');
      return [r.transfer.fromLocationId, r.transfer.toLocationId];
    }
    case 'RENEWABLE': {
      const r = await prisma.renewable.findFirst({ where: { id: entityId, asset: assetScope(actor) }, select: { asset: { select: { locationId: true } } } });
      if (!r) throw notFound('Record');
      if (write && actor.role === 'BRANCH_USER') throw forbidden('Branch users can view renewables only.');
      return [r.asset.locationId!];
    }
    case 'VERIFICATION_TASK': {
      const v = await prisma.verificationTask.findUnique({ where: { id: entityId }, include: { location: true } });
      if (!v || !inScopePath(actor, v.location.idPath)) throw notFound('Record');
      return [v.locationId];
    }
    case 'ORGANISATION':
      if (write && actor.role !== 'ADMIN') throw forbidden();
      return [];
  }
}

export async function uploadDocument(actor: Actor, p: { entityType: DocumentEntity; entityId: string; fileName: string; declaredType: string; data: Buffer; description?: string }) {
  const s = await getSettings();
  const locationIds = await assertRecordAccess(actor, p.entityType, p.entityId, true);
  const maxBytes = s.maxFileSizeMB * 1024 * 1024;
  const ext = path.extname(p.fileName).toLowerCase();
  const mime = EXT_TYPES[ext] ?? p.declaredType;
  const allowed = s.allowedFileTypes;
  if (!allowed.includes(mime)) throw badRequest(`File type ${ext || p.declaredType} is not allowed. Allowed: PDF, images (JPG, PNG, WebP, GIF) and Office documents.`);
  if (p.data.length > maxBytes && !mime.startsWith('image/')) throw badRequest(`"${p.fileName}" is ${(p.data.length / 1048576).toFixed(1)} MB; the limit is ${s.maxFileSizeMB} MB per file.`);
  const sniffed = sniff(p.data);
  const okSniff = mime === 'text/csv' ? !sniffed : mime.startsWith('application/vnd.openxml') ? sniffed === 'zip' : ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'].includes(mime) ? sniffed === 'ole' : sniffed === mime;
  if (!okSniff) throw badRequest(`The content of "${p.fileName}" does not match its type.`);
  const existing = await prisma.document.count({ where: { entityType: p.entityType, entityId: p.entityId, deletedAt: null } });
  if (existing >= s.maxFilesPerRecord) throw badRequest(`This record already has ${existing} files; the limit is ${s.maxFilesPerRecord}.`);

  let data = p.data;
  let finalMime = mime;
  // Automatic image compression (FR-DOC-02): downscale and re-encode large images.
  if (mime.startsWith('image/') && mime !== 'image/gif') {
    const sharp = (await import('sharp')).default;
    const img = sharp(p.data, { failOn: 'error' }).rotate().resize({ width: s.imageMaxDimension, height: s.imageMaxDimension, fit: 'inside', withoutEnlargement: true });
    data = mime === 'image/png' ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    if (mime !== 'image/png') finalMime = 'image/jpeg';
    if (data.length > maxBytes) throw badRequest(`"${p.fileName}" is still larger than ${s.maxFileSizeMB} MB after compression.`);
  }
  const scan = await scanBuffer(data);
  if (scan === 'INFECTED') {
    await audit(prisma, actor, { action: 'DOCUMENT_REJECTED_VIRUS', entityType: 'Document', entityLabel: p.fileName, details: { entityType: p.entityType, entityId: p.entityId }, locationIds });
    throw new AppError(422, 'VIRUS_DETECTED', `"${p.fileName}" failed the virus scan and was not stored.`);
  }
  if (scan === 'ERROR' && process.env.VIRUS_SCAN_FAIL_CLOSED === 'true') throw new AppError(503, 'SCAN_UNAVAILABLE', 'The virus scanner is unavailable; please try again later.');
  const key = newKey(`documents/${p.entityType.toLowerCase()}`);
  await putObject(key, data);
  const fileName = finalMime !== mime ? p.fileName.replace(/\.[^.]+$/, '.jpg') : p.fileName;
  const doc = await prisma.document.create({
    data: { entityType: p.entityType, entityId: p.entityId, fileName: fileName.slice(0, 200), mimeType: finalMime, sizeBytes: data.length, originalSize: p.data.length, storageKey: key, sha256: crypto.createHash('sha256').update(data).digest('hex'), scanStatus: scan, description: p.description ?? null, uploadedById: actor.id, uploadedByName: actor.name },
  });
  await audit(prisma, actor, { action: 'DOCUMENT_UPLOADED', entityType: 'Document', entityId: doc.id, entityLabel: doc.fileName, details: { record: `${p.entityType}:${p.entityId}`, size: doc.sizeBytes, originalSize: p.data.length, scan }, locationIds });
  return doc;
}

export async function listDocuments(actor: Actor, entityType: DocumentEntity, entityId: string, includeDeleted = false) {
  await assertRecordAccess(actor, entityType, entityId, false);
  return prisma.document.findMany({ where: { entityType, entityId, ...(includeDeleted && actor.role === 'ADMIN' ? {} : { deletedAt: null }) }, orderBy: { createdAt: 'desc' }, omit: { storageKey: true } });
}

export async function listAllDocuments(actor: Actor, p: { entityType?: string; search?: string; skip: number; take: number; includeDeleted?: boolean }) {
  // Scoped listing: branch users only see documents whose owning record is within their scope.
  const where = { ...(p.entityType ? { entityType: p.entityType as DocumentEntity } : {}), ...(p.search ? { fileName: { contains: p.search, mode: 'insensitive' as const } } : {}), ...(p.includeDeleted && actor.role === 'ADMIN' ? {} : { deletedAt: null }) };
  if (actor.role !== 'BRANCH_USER') {
    const [rows, total] = await Promise.all([prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take, omit: { storageKey: true } }), prisma.document.count({ where })]);
    return { rows, total };
  }
  const candidates = await prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000, omit: { storageKey: true } });
  const visible = [];
  for (const d of candidates) {
    try { await assertRecordAccess(actor, d.entityType, d.entityId, false); visible.push(d); } catch { /* out of scope */ }
  }
  return { rows: visible.slice(p.skip, p.skip + p.take), total: visible.length };
}

export async function downloadDocument(actor: Actor, id: string) {
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || doc.deletedAt && actor.role !== 'ADMIN' || doc.purgedAt) throw notFound('Document');
  const locationIds = await assertRecordAccess(actor, doc.entityType, doc.entityId, false);
  const data = await getObject(doc.storageKey);
  await audit(prisma, actor, { action: 'DOCUMENT_DOWNLOADED', entityType: 'Document', entityId: doc.id, entityLabel: doc.fileName, details: { record: `${doc.entityType}:${doc.entityId}` }, locationIds });
  return { doc, data };
}

/** Soft delete, Administrator only (FR-DOC-04). The file is retained for the retention window. */
export async function deleteDocument(actor: Actor, id: string, reason: string) {
  if (actor.role !== 'ADMIN') {
    await audit(prisma, actor, { action: 'ACCESS_DENIED', entityType: 'Document', entityId: id, details: { attempted: 'delete' } });
    throw forbidden('Only an Administrator can delete documents.');
  }
  if (!reason?.trim()) throw badRequest('A reason is required to delete a document.');
  return tx(async (t) => {
    const doc = await t.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt) throw notFound('Document');
    await t.document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id, deleteReason: reason } });
    await audit(t, actor, { action: 'DOCUMENT_DELETED', entityType: 'Document', entityId: id, entityLabel: doc.fileName, details: { reason, record: `${doc.entityType}:${doc.entityId}`, soft: true } });
    return { ok: true };
  });
}

export async function restoreDocument(actor: Actor, id: string) {
  if (actor.role !== 'ADMIN') throw forbidden();
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || !doc.deletedAt || doc.purgedAt) throw notFound('Deleted document');
  await prisma.document.update({ where: { id }, data: { deletedAt: null, deletedById: null, deleteReason: null } });
  await audit(prisma, actor, { action: 'DOCUMENT_RESTORED', entityType: 'Document', entityId: id, entityLabel: doc.fileName });
  return { ok: true };
}

/** Retention job: physically remove files soft-deleted longer ago than the retention setting. */
export async function purgeExpiredDocuments() {
  const s = await getSettings();
  const cutoff = new Date(Date.now() - s.documentRetentionYears * 365.25 * 86_400_000);
  const docs = await prisma.document.findMany({ where: { deletedAt: { lt: cutoff }, purgedAt: null } });
  for (const d of docs) {
    await deleteObject(d.storageKey);
    await prisma.document.update({ where: { id: d.id }, data: { purgedAt: new Date() } });
  }
  return { purged: docs.length };
}
