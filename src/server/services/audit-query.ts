import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { forbidden } from '@/lib/errors';
import type { Actor } from '../actor';

export interface AuditFilters { entityType?: string; entityId?: string; entityLabel?: string; actor?: string; action?: string; dateFrom?: string; dateTo?: string }

/** FR-AUD-02: searchable by entity, actor, action and date range. Branch users are denied; IT sees all. */
export async function auditWhere(actor: Actor, f: AuditFilters): Promise<Prisma.AuditLogWhereInput> {
  if (actor.role === 'BRANCH_USER') throw forbidden('The audit log is available to IT and Administrators.');
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.entityType) and.push({ entityType: f.entityType });
  if (f.entityId) and.push({ entityId: f.entityId });
  if (f.entityLabel) and.push({ entityLabel: { contains: f.entityLabel, mode: 'insensitive' } });
  if (f.actor) and.push({ OR: [{ actorEmail: { contains: f.actor, mode: 'insensitive' } }, { actorId: f.actor }] });
  if (f.action) and.push({ action: { contains: f.action.toUpperCase() } });
  if (f.dateFrom) and.push({ at: { gte: new Date(Date.parse(`${f.dateFrom}T00:00:00+05:30`)) } });
  if (f.dateTo) and.push({ at: { lt: new Date(Date.parse(`${f.dateTo}T00:00:00+05:30`) + 86_400_000) } });
  return { AND: and };
}

export async function listAudit(actor: Actor, f: AuditFilters, p: { skip: number; take: number }) {
  const where = await auditWhere(actor, f);
  const [rows, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { at: 'desc' }, skip: p.skip, take: p.take }), prisma.auditLog.count({ where })]);
  return { rows: rows.map((r) => ({ ...r, id: r.id.toString() })), total };
}

export async function auditActions() {
  const rows = await prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
  const types = await prisma.auditLog.findMany({ distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } });
  return { actions: rows.map((r) => r.action), entityTypes: types.map((t) => t.entityType) };
}
