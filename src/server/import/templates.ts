import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';

export interface Column { key: string; header: string; required?: boolean; help: string; example: string; aliases?: string[] }

export const ASSET_COLUMNS: Column[] = [
  { key: 'category', header: 'Category', required: true, help: 'An existing active category name, e.g. Laptop', example: 'Laptop' },
  { key: 'make', header: 'Make', required: true, help: 'Manufacturer', example: 'Dell' },
  { key: 'model', header: 'Model', required: true, help: 'Model name', example: 'Latitude 5440' },
  { key: 'serialnumber', header: 'Serial Number', help: 'Required when the category requires serials. Unique, case-insensitive', example: 'SN-XYZ123', aliases: ['serial', 'serialno', 'sno', 'servicetag'] },
  { key: 'hostname', header: 'Hostname', help: 'Device / system name. Duplicates warn', example: 'KL-LAP-07', aliases: ['devicename', 'systemname', 'computername'] },
  { key: 'ipaddress', header: 'IP Address', help: 'IPv4 or IPv6. Duplicates warn', example: '10.10.1.25', aliases: ['ip'] },
  { key: 'macaddress', header: 'MAC Address', help: 'For reference; not a duplicate key', example: '00:1A:2B:3C:4D:5E', aliases: ['mac'] },
  { key: 'legacytag', header: 'Legacy Tag', help: 'Existing tag/label number; unique if present', example: 'OLD-4471', aliases: ['assettag', 'tag', 'oldtag'] },
  { key: 'location', header: 'Location', required: true, help: 'Location path Region/Branch, e.g. South/Kerala/Angamaly (or a unique branch name). A missing one can be added from the preview', example: 'South/Kerala/Angamaly', aliases: ['branch', 'locationpath'] },
  { key: 'department', header: 'Department', help: 'Optional. An existing department. With no Holder Employee ID, the asset is created Assigned to this department. A missing one can be added from the preview', example: 'IT', aliases: ['dept'] },
  { key: 'holderemployeeid', header: 'Holder Employee ID', help: 'Optional. Existing employee ID; the asset is created Assigned to them', example: 'E1001', aliases: ['employeeid', 'holder', 'assignedto'] },
  { key: 'purchasedate', header: 'Purchase Date', help: 'YYYY-MM-DD or DD-MMM-YYYY', example: '2024-04-15' },
  { key: 'purchasecost', header: 'Purchase Cost', help: 'INR, numbers only', example: '65000', aliases: ['cost'] },
  { key: 'vendor', header: 'Vendor', help: 'Supplier name', example: 'ABC Systems' },
  { key: 'warrantyend', header: 'Warranty End', help: 'YYYY-MM-DD or DD-MMM-YYYY; creates a warranty renewable', example: '2027-04-14', aliases: ['warrantyexpiry', 'warranty'] },
  { key: 'condition', header: 'Condition', help: 'Free text, e.g. Good', example: 'Good' },
  { key: 'remarks', header: 'Remarks', help: 'Free text', example: '' },
];

export const EMPLOYEE_COLUMNS: Column[] = [
  { key: 'employeeid', header: 'Employee ID', required: true, help: 'Unique employee code', example: 'E1001', aliases: ['empid', 'employeecode', 'code'] },
  { key: 'name', header: 'Name', required: true, help: 'Full name', example: 'Anita Menon', aliases: ['fullname', 'employeename'] },
  { key: 'email', header: 'Email', help: 'Work email', example: 'anita.menon@example.com' },
  { key: 'department', header: 'Department', help: 'Existing department name (or tick "create missing")', example: 'Operations' },
  { key: 'location', header: 'Location', help: 'Location path Region/Branch', example: 'South/Kerala/Angamaly', aliases: ['branch'] },
  { key: 'manageremployeeid', header: 'Manager Employee ID', help: 'Employee ID of the manager (may be in the same file)', example: 'E1000', aliases: ['manager', 'managerid'] },
  { key: 'active', header: 'Active', help: 'Y or N (default Y)', example: 'Y' },
];

export const BRANCH_USER_COLUMNS: Column[] = [
  { key: 'branch', header: 'Branch', required: true, help: 'Location path of the branch the login is bound to', example: 'South/Kerala/Angamaly', aliases: ['location'] },
  { key: 'email', header: 'Email', required: true, help: 'Branch login email; an invite is sent', example: 'angamaly.branch@example.com' },
  { key: 'name', header: 'Name', help: 'Display name (defaults to the branch name)', example: 'Angamaly Branch' },
];

export const COLUMNS = { ASSETS: ASSET_COLUMNS, EMPLOYEES: EMPLOYEE_COLUMNS, BRANCH_USERS: BRANCH_USER_COLUMNS } as const;

export function aliasMap(cols: Column[]) {
  const m: Record<string, string> = {};
  for (const c of cols) {
    m[c.key] = c.key;
    m[c.header.toLowerCase().replace(/[^a-z0-9]/g, '')] = c.key;
    for (const a of c.aliases ?? []) m[a] = c.key;
  }
  return m;
}

export async function templateFile(type: keyof typeof COLUMNS, format: 'csv' | 'xlsx'): Promise<{ data: Buffer; mime: string; name: string }> {
  const cols = COLUMNS[type];
  const base = `${type.toLowerCase()}-import-template`;
  if (format === 'csv') {
    const lines = [
      cols.map((c) => c.header + (c.required ? '*' : '')),
      cols.map((c) => c.example),
    ];
    const help = `# Column help:\n${cols.map((c) => `# ${c.header}${c.required ? ' (required)' : ''}: ${c.help}`).join('\n')}\n# Delete the example row and these comment lines before uploading.\n`;
    return { data: Buffer.from('﻿' + stringify(lines) + help.replace(/^# /gm, '#,')), mime: 'text/csv', name: `${base}.csv` };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.columns = cols.map((c) => ({ header: c.header + (c.required ? '*' : ''), key: c.key, width: Math.max(14, c.header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.addRow(Object.fromEntries(cols.map((c) => [c.key, c.example])));
  cols.forEach((c, i) => { ws.getCell(1, i + 1).note = c.help; });
  const help = wb.addWorksheet('Help');
  help.columns = [{ header: 'Column', key: 'c', width: 24 }, { header: 'Required', key: 'r', width: 10 }, { header: 'Help', key: 'h', width: 80 }, { header: 'Example', key: 'e', width: 28 }];
  help.getRow(1).font = { bold: true };
  for (const c of cols) help.addRow({ c: c.header, r: c.required ? 'Yes' : '', h: c.help, e: c.example });
  help.addRow({});
  help.addRow({ c: 'Note', h: 'Delete the example row on the Data sheet before uploading. Every upload runs as a dry run first; nothing is saved until you confirm.' });
  return { data: Buffer.from(await wb.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${base}.xlsx` };
}
