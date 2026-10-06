import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { badRequest } from '@/lib/errors';

export interface ParsedRow { rowNumber: number; data: Record<string, string> }

export const normHeader = (h: string) => h.toLowerCase().replace(/\*/g, '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('hyperlink' in v) return String((v as { text?: string }).text ?? '');
  }
  return String(v);
}

/** Parse a CSV or XLSX upload into rows keyed by normalised header. Row numbers are the spreadsheet row numbers. */
export async function parseTabular(fileName: string, buf: Buffer, aliases: Record<string, string>, maxRows = 20_000): Promise<{ rows: ParsedRow[]; headers: string[] }> {
  const lower = fileName.toLowerCase();
  let table: string[][] = [];
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    try {
      table = parseCsv(buf.toString('utf8').replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: false, bom: true }) as string[][];
    } catch (e) {
      throw badRequest(`The CSV file could not be read: ${(e as Error).message}`);
    }
  } else if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw badRequest('The Excel file could not be read. Save it as .xlsx (Excel 2007 or later) or CSV and try again.');
    }
    const ws = wb.worksheets.find((w) => !/help|instructions/i.test(w.name)) ?? wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no worksheets.');
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      table[n - 1] = vals;
    });
    table = Array.from(table, (r) => r ?? []);
  } else {
    throw badRequest('Upload a .csv or .xlsx file.');
  }
  const headerIdx = table.findIndex((r) => r && r.some((c) => c && c.trim()));
  if (headerIdx < 0) throw badRequest('The file is empty.');
  const rawHeaders = table[headerIdx].map((h) => (h ?? '').trim());
  const headers = rawHeaders.map((h) => aliases[normHeader(h)] ?? normHeader(h));
  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    if (!r.some((c) => c && String(c).trim())) continue;
    if (String(r[0] ?? '').trim().startsWith('#')) continue; // template help lines
    const data: Record<string, string> = {};
    headers.forEach((h, j) => { if (h) data[h] = String(r[j] ?? '').trim(); });
    rows.push({ rowNumber: i + 1, data });
    if (rows.length > maxRows) throw badRequest(`The file has more than ${maxRows.toLocaleString('en-IN')} data rows. Split it into smaller files.`);
  }
  if (!rows.length) throw badRequest('The file has a header row but no data rows.');
  return { rows, headers };
}

export { parseDate } from '@/lib/parse-date';
