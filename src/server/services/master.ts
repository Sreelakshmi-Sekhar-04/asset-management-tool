import { z } from 'zod';
import { prisma, tx } from '@/lib/db';
import { conflict, notFound } from '@/lib/errors';
import type { Actor } from '../actor';
import { audit, diff } from '../audit';
import { getSettings, invalidateSettings, DEFAULT_SETTINGS, type Settings } from '../settings';

// ── Categories (FR-CFG-02) ──
export const categoryInput = z.object({
  name: z.string().trim().min(1).max(80),
  serialRequired: z.boolean().default(false),
  individuallyTracked: z.boolean().default(true),
  isSoftware: z.boolean().default(false),
  active: z.boolean().optional(),
});

export async function listCategories(includeInactive = false) {
  const rows = await prisma.assetCategory.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: 'asc' } });
  const counts = await prisma.asset.groupBy({ by: ['categoryId'], _count: true });
  const m = new Map(counts.map((c) => [c.categoryId, c._count]));
  return rows.map((r) => ({ ...r, assetCount: m.get(r.id) ?? 0 }));
}

export async function createCategory(actor: Actor, input: unknown) {
  const data = categoryInput.parse(input);
  return tx(async (t) => {
    if (await t.assetCategory.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })) throw conflict(`Category "${data.name}" already exists.`);
    const c = await t.assetCategory.create({ data: { ...data, active: data.active ?? true } });
    await audit(t, actor, { action: 'CATEGORY_CREATED', entityType: 'Category', entityId: c.id, entityLabel: c.name, after: c });
    return c;
  });
}

export async function updateCategory(actor: Actor, id: string, input: unknown) {
  const data = categoryInput.partial().parse(input);
  return tx(async (t) => {
    const c = await t.assetCategory.findUnique({ where: { id } });
    if (!c) throw notFound('Category');
    if (data.name && data.name.toLowerCase() !== c.name.toLowerCase() && (await t.assetCategory.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })))
      throw conflict(`Category "${data.name}" already exists.`);
    const u = await t.assetCategory.update({ where: { id }, data });
    const d = diff(c as unknown as Record<string, unknown>, data as Record<string, unknown>);
    await audit(t, actor, { action: data.active === false ? 'CATEGORY_DEACTIVATED' : 'CATEGORY_UPDATED', entityType: 'Category', entityId: id, entityLabel: u.name, before: d.before, after: d.after });
    return u;
  });
}

// ── Departments (FR-CFG-04) ──
export const departmentInput = z.object({ name: z.string().trim().min(1).max(120), active: z.boolean().optional() });

export async function listDepartments(includeInactive = false) {
  return prisma.department.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { name: 'asc' }, include: { _count: { select: { employees: true } } } });
}

export async function createDepartment(actor: Actor, input: unknown) {
  const data = departmentInput.parse(input);
  return tx(async (t) => {
    if (await t.department.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })) throw conflict(`Department "${data.name}" already exists.`);
    const d = await t.department.create({ data: { name: data.name } });
    await audit(t, actor, { action: 'DEPARTMENT_CREATED', entityType: 'Department', entityId: d.id, entityLabel: d.name, after: d });
    return d;
  });
}

export async function updateDepartment(actor: Actor, id: string, input: unknown) {
  const data = departmentInput.partial().parse(input);
  return tx(async (t) => {
    const d0 = await t.department.findUnique({ where: { id } });
    if (!d0) throw notFound('Department');
    if (data.name && data.name.toLowerCase() !== d0.name.toLowerCase() && (await t.department.findFirst({ where: { name: { equals: data.name, mode: 'insensitive' } } })))
      throw conflict(`Department "${data.name}" already exists.`);
    const d = await t.department.update({ where: { id }, data });
    const df = diff(d0 as unknown as Record<string, unknown>, data as Record<string, unknown>);
    await audit(t, actor, { action: 'DEPARTMENT_UPDATED', entityType: 'Department', entityId: id, entityLabel: d.name, before: df.before, after: df.after });
    return d;
  });
}

// ── Settings / organisation (FR-CFG-01, 06, 08) ──
const severity = z.enum(['BLOCK', 'WARN', 'OFF']);
export const settingsInput = z.object({
  orgName: z.string().trim().min(1).max(120),
  orgLogoDocumentId: z.string().nullable(),
  sessionIdleMinutes: z.number().int().min(5).max(480),
  sessionAbsoluteHours: z.number().int().min(1).max(72),
  lockoutThreshold: z.number().int().min(3).max(20),
  lockoutMinutes: z.number().int().min(1).max(1440),
  passwordMinLength: z.number().int().min(8).max(64),
  transferAgingDays: z.number().int().min(1).max(365),
  // Serial is a unique field in the data model, so it can only block (see ARCHITECTURE.md).
  duplicateRules: z.object({ serial: z.literal('BLOCK'), hostname: severity, ip: severity }),
  maxFileSizeMB: z.number().min(0.5).max(50),
  maxFilesPerRecord: z.number().int().min(1).max(200),
  allowedFileTypes: z.array(z.string()).min(1),
  imageMaxDimension: z.number().int().min(320).max(8000),
  documentRetentionYears: z.number().int().min(1).max(30),
  auditRetentionYears: z.number().int().min(7, 'Audit retention is at least 7 years (NFR-08)').max(50),
  importReportRetentionMonths: z.number().int().min(12).max(120),
  scannerAdvanceKey: z.enum(['Enter', 'Tab']),
  verificationReminderDays: z.array(z.number().int().min(0).max(90)),
  notificationEmail: z.record(z.boolean()),
}).partial();

export async function updateSettings(actor: Actor, input: unknown) {
  const data = settingsInput.parse(input);
  const before = await getSettings();
  await tx(async (t) => {
    for (const [key, value] of Object.entries(data)) {
      await t.setting.upsert({ where: { key }, update: { value: value as object, updatedBy: actor.id }, create: { key, value: value as object, updatedBy: actor.id } });
    }
    const b: Record<string, unknown> = {};
    for (const k of Object.keys(data)) b[k] = (before as unknown as Record<string, unknown>)[k];
    await audit(t, actor, { action: 'SETTINGS_CHANGED', entityType: 'Settings', entityLabel: Object.keys(data).join(', '), before: b, after: data });
  });
  invalidateSettings();
  return getSettings();
}

export async function publicSettings() {
  const s = await getSettings();
  return { orgName: s.orgName, orgLogoDocumentId: s.orgLogoDocumentId, scannerAdvanceKey: s.scannerAdvanceKey, sessionIdleMinutes: s.sessionIdleMinutes } satisfies Partial<Settings>;
}

export { DEFAULT_SETTINGS };
