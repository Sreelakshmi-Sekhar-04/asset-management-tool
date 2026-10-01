import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { prisma } from '@/lib/db';
import type { Actor } from './actor';
import { audit } from './audit';

export interface ExportColumn { key: string; header: string; format?: (v: unknown, row: Record<string, unknown>) => string | number | null }

function cell(c: ExportColumn, row: Record<string, unknown>) {
  const v = c.key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], row);
  if (c.format) return c.format(v, row);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

/** Neutralise spreadsheet formula injection in exported text. */
const safe = (v: string | number | null) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** FR-IMP-11: export a list/report as CSV or Excel; every export is audited with its row count and filters. */
export async function buildExport(actor: Actor, p: { name: string; columns: ExportColumn[]; rows: Record<string, unknown>[]; format: 'csv' | 'xlsx'; filters?: unknown }) {
  const matrix = p.rows.map((r) => p.columns.map((c) => safe(cell(c, r) as string | number | null)));
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${p.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${stamp}`;
  let data: Buffer, mime: string, file: string;
  if (p.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(p.name.slice(0, 31));
    ws.addRow(p.columns.map((c) => c.header));
    ws.getRow(1).font = { bold: true };
    for (const r of matrix) ws.addRow(r);
    ws.columns.forEach((col, i) => { col.width = Math.min(50, Math.max(10, p.columns[i].header.length + 2)); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    data = Buffer.from(await wb.xlsx.writeBuffer());
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    file = `${base}.xlsx`;
  } else {
    data = Buffer.from('﻿' + stringify([p.columns.map((c) => c.header), ...matrix]));
    mime = 'text/csv; charset=utf-8';
    file = `${base}.csv`;
  }
  await audit(prisma, actor, { action: 'EXPORT', entityType: 'Report', entityLabel: p.name, details: { rows: p.rows.length, format: p.format, filters: p.filters, scope: actor.role === 'BRANCH_USER' ? actor.scopeName : 'all' }, locationIds: actor.locationId ? [actor.locationId] : [] });
  return { data, mime, file };
}

export function fileResponse(f: { data: Buffer; mime: string; file: string }) {
  return new Response(new Uint8Array(f.data), { headers: { 'content-type': f.mime, 'content-disposition': `attachment; filename="${f.file}"`, 'cache-control': 'no-store' } });
}
