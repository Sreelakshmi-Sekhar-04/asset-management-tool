'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseDate } from '@/lib/parse-date';
import { api, qs } from './api';
import { AssetStatus } from './badges';
import { Dash, HolderCell, LocationCell, WarrantyCell } from './asset-list-parts';
import type { Column } from './list';
import { Badge, clsx } from './ui';

export interface ImportAssetRow {
  id: string; rowNumber: number; data: Record<string, string>; outcome: string; messages: string[]; resultCode: string | null;
  view?: { holderName: string | null; asset: { id: string; assetCode: string; status: string } | null; duplicate?: ImportDuplicate | null };
}

/** Why a row matches an asset already in the register: the field, the uploaded value, and that asset. */
export interface ImportDuplicate {
  field: string; fieldLabel: string; value: string;
  asset: { id: string; assetCode: string; name: string; category: string; serialNumber: string | null; legacyTag: string | null; status: string };
}

export const OUT_TONE: Record<string, string> = { CREATED: 'green', UPDATED: 'blue', UNCHANGED: 'gray', WARNING: 'amber', REJECTED: 'red' };
/**
 * What each row is, found by matching it against the register (no mode to choose). UNCHANGED is
 * stored as such, but to the user a row already in the register with the same details is a duplicate.
 */
export const OUT_LABEL: Record<string, string> = { CREATED: 'New', UPDATED: 'Existing', UNCHANGED: 'Duplicate', WARNING: 'Possible duplicate', REJECTED: 'Invalid' };
/** What confirming will do with the row. */
export const OUT_ACTION: Record<string, string> = { CREATED: 'Create', UPDATED: 'Update', UNCHANGED: 'Skip', WARNING: 'Review', REJECTED: 'Fix' };

/** Fields shown only in the "More fields" dialog while a row is edited. */
export const MORE_FIELDS: { key: string; label: string; type?: string }[] = [
  { key: 'macaddress', label: 'MAC address' }, { key: 'purchasedate', label: 'Purchase date', type: 'date' }, { key: 'purchasecost', label: 'Purchase cost (INR)' },
  { key: 'vendor', label: 'Vendor' }, { key: 'condition', label: 'Condition' }, { key: 'remarks', label: 'Remarks' },
];

/**
 * Inline editing of the preview while the dry run waits for confirmation. One row is edited at a time;
 * Save stores it and the whole file is checked again on the server.
 */
export interface RowEditor {
  editing: number | null; draft: Record<string, string>; focus: string | null; saving: boolean;
  start: (r: ImportAssetRow, focus?: string) => void; set: (k: string, v: string) => void; cancel: () => void; save: () => void;
  /** Opens the camera for this row's serial. */
  scan: (r: ImportAssetRow) => void;
  more: () => void;
  categories: string[]; locations: string[];
}

const g = (r: ImportAssetRow, k: string) => (r.data[k] ?? '').trim();
/** "South/Kerala/Kochi" → "South / Kerala / Kochi", the form the register uses. */
const locPath = (s: string) => s ? s.split(/[/\\>]/).map((x) => x.trim()).filter(Boolean).join(' / ') : null;

/** The location in the list that a path from the file means ("Kochi" or "South/Kerala/Kochi"), else the text as typed. */
function matchLocation(options: string[], v: string) {
  const p = (locPath(v) ?? '').toLowerCase();
  if (!p) return v;
  const hits = options.filter((o) => o.toLowerCase() === p || o.toLowerCase().endsWith(' / ' + p));
  return hits.length === 1 ? hits[0] : v;
}

/** Which cell a check message is about, so the problem is shown (and fixed) where it is. */
const FIELD_OF: [RegExp, string][] = [
  [/^Category is required|^Unknown category|^Category ".*" is inactive/, 'category'],
  [/^Make is required/, 'make'], [/^Model is required/, 'model'],
  [/^Location is required|^Unknown location|^Location ".*" matches more than one/, 'location'],
  [/^Serial |^Duplicate: serial /, 'serialnumber'],
  [/^Legacy tag |^Duplicate: legacy tag /, 'legacytag'],
  [/^IP address |^Duplicate IP |IP "/, 'ipaddress'],
  [/hostname/i, 'hostname'],
  [/^Unknown employee |^Employee .* is inactive/, 'holderemployeeid'],
  [/^Warranty end /, 'warrantyend'],
];
const fieldOf = (m: string) => FIELD_OF.find(([re]) => re.test(m))?.[1] ?? null;
/** Cells that show their own problems; others (MAC, purchase date, cost) stay in the Row column. */
const CELL_FIELDS = new Set(['category', 'make', 'model', 'location', 'serialnumber', 'legacytag', 'ipaddress', 'hostname', 'holderemployeeid', 'warrantyend']);
const isProblem = (r: ImportAssetRow) => r.outcome === 'REJECTED' || r.outcome === 'WARNING';
const issuesFor = (r: ImportAssetRow, k: string) => (isProblem(r) ? r.messages.filter((m) => fieldOf(m) === k) : []);

/** Why the row's serial cannot be imported, in the words Bulk add uses. */
function serialProblem(r: ImportAssetRow): ReactNode {
  for (const m of r.messages) {
    let x: RegExpMatchArray | null;
    if ((x = m.match(/^Serial ".*" is duplicated within the file \(rows (\d+) and (\d+)\)/))) return `Also in row ${x[1] === String(r.rowNumber) ? x[2] : x[1]} of the file.`;
    if (/^Duplicate: serial /.test(m) || /^Serial .* already belongs to /.test(m)) {
      const a = r.view?.asset;
      const code = a?.assetCode ?? m.match(/(?:on|to) (\S+?)(?: \(retired\))?\./)?.[1];
      return <>Already registered as {a ? <Link href={`/assets/${a.id}`} className="font-medium">{a.assetCode}</Link> : code}.</>;
    }
    if (/^Serial number is required/.test(m)) return 'Serial number is required.';
  }
  return null;
}

/** Employee ID box that suggests matching employees as you type. */
function EmployeeCodeInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [opts, setOpts] = useState<{ employeeCode: string; name: string }[]>([]);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(t.current);
    t.current = setTimeout(() => {
      api<{ rows: { employeeCode: string; name: string }[] }>(`/api/employees${qs({ search: value, active: 'true', pageSize: 10 })}`).then((r) => setOpts(r.rows)).catch(() => setOpts([]));
    }, 250);
    return () => clearTimeout(t.current);
  }, [value]);
  return (
    <>
      <input className="input w-36 py-1 text-xs" list="import-employee-codes" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Employee ID (blank = unassigned)" autoFocus={autoFocus} />
      <datalist id="import-employee-codes">{opts.map((e) => <option key={e.employeeCode} value={e.employeeCode}>{e.name}</option>)}</datalist>
    </>
  );
}

/**
 * The asset import preview in the asset register's own columns, so a row reads the same before
 * and after it is imported. Asset ID is left out: it is assigned when the row is imported.
 * With an editor (a dry run waiting for confirmation) every cell can be corrected in place.
 */
export function importAssetColumns(ed?: RowEditor): Column<ImportAssetRow>[] {
  const editing = (r: ImportAssetRow) => !!ed && ed.editing === r.rowNumber;

  /** A cell: its value, any problem with it underneath, and (while editable) click to edit. */
  const cell = (r: ImportAssetRow, k: string, view: ReactNode, input?: (v: string, set: (v: string) => void, autoFocus: boolean) => ReactNode) => {
    if (ed && editing(r)) {
      const v = ed.draft[k] ?? '';
      const af = ed.focus === k;
      return input ? input(v, (x) => ed.set(k, x), af)
        : <input className="input w-32 py-1 text-xs" value={v} onChange={(e) => ed.set(k, e.target.value)} autoFocus={af} onKeyDown={(e) => { if (e.key === 'Enter') ed.save(); if (e.key === 'Escape') ed.cancel(); }} />;
    }
    const issues = k === 'serialnumber' ? [] : issuesFor(r, k);
    const bad = r.outcome === 'REJECTED' && issues.length > 0;
    const body = (
      <>
        <span className={clsx(bad && 'rounded bg-red-50 px-1 ring-1 ring-red-300', !bad && issues.length > 0 && 'rounded bg-amber-50 px-1 ring-1 ring-amber-300')}>{view}</span>
        {issues.map((m) => <span key={m} className={clsx('mt-1 block min-w-[9rem] max-w-[14rem] text-[11px]', bad ? 'text-red-700' : 'text-amber-800')}>{m}</span>)}
      </>
    );
    if (!ed || ed.editing !== null) return <span className="block">{body}</span>;
    return (
      <span role="button" tabIndex={0} title="Click to edit" className="-m-1 block cursor-text rounded p-1 hover:bg-brand-50 hover:ring-1 hover:ring-brand-200"
        onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button')) ed.start(r, k); }} onKeyDown={(e) => { if (e.key === 'Enter') ed.start(r, k); }}>
        {body}
      </span>
    );
  };

  const choose = (options: string[], placeholder: string, w = 'w-40') => function choice(v: string, set: (v: string) => void, af: boolean) { return (
    <select className={`input ${w} py-1 text-xs`} value={v} onChange={(e) => set(e.target.value)} autoFocus={af}>
      <option value="">{placeholder}</option>
      {v && !options.some((o) => o.toLowerCase() === v.toLowerCase()) && <option value={v}>{v} (not found)</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  ); };

  const cols: Column<ImportAssetRow>[] = [
    { key: 'row', header: 'Row', className: 'align-top', render: (r) => {
      // New rows need no note: their location and holder already show in the columns.
      // Problems that belong to a visible cell are shown on that cell instead.
      // A duplicate is explained by the field that matched and the existing asset, not the raw message.
      const dup = r.outcome === 'UNCHANGED' ? r.view?.duplicate : null;
      const notes = r.outcome === 'CREATED' || dup ? [] : r.messages.filter((m) => !(isProblem(r) && CELL_FIELDS.has(fieldOf(m) ?? '')));
      return (
        <span className="flex flex-col items-start gap-1">
          <span className="flex items-center gap-2"><span className="text-slate-500">{r.rowNumber}</span><Badge tone={OUT_TONE[r.outcome]}>{OUT_LABEL[r.outcome]}</Badge></span>
          <span className="text-[11px] text-slate-500">Action: <b className="font-medium text-slate-700">{OUT_ACTION[r.outcome]}</b></span>
          {dup && <DuplicateNote d={dup} />}
          {notes.length > 0 && <span className={`block w-52 text-xs ${r.outcome === 'REJECTED' ? 'text-red-800' : r.outcome === 'WARNING' ? 'text-amber-800' : 'text-slate-600'}`}>{notes.join(' ')}</span>}
        </span>
      );
    } },
    { key: 'serialNumber', header: 'Serial number', className: 'align-top', render: (r) => {
      const serial = g(r, 'serialnumber');
      const problem = serialProblem(r);
      if (ed && editing(r)) {
        return (
          <span className="flex items-center gap-1">
            <input className="input w-36 py-1 font-mono text-xs" value={ed.draft.serialnumber ?? ''} placeholder="Enter serial number" autoFocus={ed.focus === 'serialnumber'}
              onChange={(e) => ed.set('serialnumber', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ed.save(); if (e.key === 'Escape') ed.cancel(); }} />
            <button type="button" className="btn btn-sm" onClick={() => ed.scan(r)}>Scan</button>
          </span>
        );
      }
      if (!serial) {
        const required = r.messages.some((m) => /^Serial number is required/.test(m));
        return (
          <span className="block min-w-[10rem]">
            <span className={clsx('text-xs font-medium', required ? 'text-red-700' : 'text-amber-700')}>{required ? 'Missing: serial number is required' : 'Missing'}</span>
            {ed && ed.editing === null && (
              <span className="mt-1 flex gap-1">
                <button type="button" className="btn btn-sm" onClick={() => ed.scan(r)}>Scan</button>
                <button type="button" className="btn btn-sm" onClick={() => ed.start(r, 'serialnumber')}>Enter manually</button>
              </span>
            )}
          </span>
        );
      }
      return cell(r, 'serialnumber', (
        <>
          <span className={problem ? 'whitespace-nowrap rounded bg-red-50 px-1 font-mono text-xs text-red-800 ring-1 ring-red-300' : 'whitespace-nowrap font-mono text-xs text-slate-700'}>{serial}</span>
          {problem && <span className="mt-1 block min-w-[9rem] text-[11px] text-red-700">{problem}</span>}
        </>
      ));
    } },
    { key: 'make', header: 'Make', className: 'align-top', render: (r) => cell(r, 'make', <span className="whitespace-nowrap text-slate-600">{g(r, 'make') || <Dash />}</span>) },
    { key: 'model', header: 'Model', className: 'align-top', render: (r) => cell(r, 'model', <span className="block min-w-[6.5rem] font-medium text-slate-900">{g(r, 'model') || <Dash />}</span>) },
    { key: 'category', header: 'Category', className: 'align-top', render: (r) => cell(r, 'category', <span className="whitespace-nowrap">{g(r, 'category') || <Dash />}</span>, ed && choose(ed.categories, 'Choose a category', 'w-36')) },
    { key: 'legacyTag', header: 'Legacy tag', className: 'align-top', render: (r) => cell(r, 'legacytag', <span className="whitespace-nowrap text-xs">{g(r, 'legacytag') || <Dash />}</span>) },
    { key: 'ipAddress', header: 'IP address', className: 'align-top', render: (r) => cell(r, 'ipaddress', <span className="whitespace-nowrap font-mono text-xs">{g(r, 'ipaddress') || <Dash />}</span>) },
    { key: 'hostname', header: 'Hostname', className: 'align-top', render: (r) => cell(r, 'hostname', <span className="whitespace-nowrap">{g(r, 'hostname') || <Dash />}</span>) },
    { key: 'location', header: 'Location', className: 'align-top', render: (r) => cell(r, 'location', <LocationCell path={locPath(g(r, 'location'))} />, ed && ((v, set, af) => choose(ed.locations, 'Choose a location', 'w-56')(matchLocation(ed.locations, v), set, af))) },
    { key: 'holder', header: 'Assigned to', className: 'align-top', render: (r) => {
      const code = g(r, 'holderemployeeid');
      const view = !code ? <HolderCell type={null} holder={null} /> : <HolderCell type="EMPLOYEE" holder={r.view?.holderName ? `${r.view.holderName} (${code})` : code} />;
      return cell(r, 'holderemployeeid', view, (v, set, af) => <EmployeeCodeInput value={v} onChange={set} autoFocus={af} />);
    } },
    { key: 'status', header: 'Status', className: 'align-top', render: (r) => {
      if (r.view?.asset) return <AssetStatus s={r.view.asset.status} />;
      if (r.outcome === 'REJECTED') return <Dash />;
      return <AssetStatus s={g(r, 'holderemployeeid') ? 'ASSIGNED' : 'IN_STOCK'} />;
    } },
    { key: 'warrantyEnd', header: 'Warranty end', className: 'align-top', render: (r) => {
      const raw = g(r, 'warrantyend');
      const d = raw ? parseDate(raw) : null;
      return cell(r, 'warrantyend', raw && !d ? <span className="text-xs text-red-700">{raw}</span> : <WarrantyCell end={d} />,
        (v, set, af) => <input type="date" className="input w-36 py-1 text-xs" value={parseDate(v) ?? ''} onChange={(e) => set(e.target.value)} autoFocus={af} />);
    } },
  ];
  if (ed) cols.push({ key: 'action', header: 'Action', className: 'sticky right-0 z-[1] bg-white align-top shadow-[-1px_0_0_#e2e8f0]', render: (r) => editing(r) ? (
    <span className="flex flex-col gap-1">
      <button type="button" className="btn btn-primary btn-sm" disabled={ed.saving} onClick={ed.save}>{ed.saving ? 'Checking…' : 'Save'}</button>
      <button type="button" className="btn btn-sm" disabled={ed.saving} onClick={ed.more}>More fields</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={ed.saving} onClick={ed.cancel}>Cancel</button>
    </span>
  ) : <button type="button" className="btn btn-sm" disabled={ed.editing !== null} onClick={() => ed.start(r)}>Edit</button> });
  return cols;
}

/** "Duplicate field: Serial number · Uploaded value · Existing asset AST-… (Dell Latitude, serial …)". */
function DuplicateNote({ d }: { d: ImportDuplicate }) {
  return (
    <span className="block w-56 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] leading-snug text-slate-700">
      <span className="block"><b>Duplicate field:</b> {d.fieldLabel}</span>
      {d.field !== 'details' && <span className="block"><b>Uploaded value:</b> <span className="font-mono">{d.value}</span></span>}
      <span className="block"><b>Existing asset:</b> <Link href={`/assets/${d.asset.id}`} className="font-medium">{d.asset.assetCode}</Link> · {d.asset.name}</span>
      {d.asset.serialNumber && <span className="block"><b>Existing serial:</b> <span className="font-mono">{d.asset.serialNumber}</span></span>}
      {d.asset.legacyTag && <span className="block"><b>Existing legacy tag:</b> {d.asset.legacyTag}</span>}
    </span>
  );
}
