'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { parseDate } from '@/lib/parse-date';
import { AssetStatus } from './badges';
import { Dash, HolderCell, LocationCell, WarrantyCell } from './asset-list-parts';
import type { Column } from './list';
import { Badge } from './ui';

export interface ImportAssetRow {
  id: string; rowNumber: number; data: Record<string, string>; outcome: string; messages: string[]; resultCode: string | null;
  view?: { holderName: string | null; asset: { id: string; assetCode: string; status: string } | null };
}

export const OUT_TONE: Record<string, string> = { CREATED: 'green', UPDATED: 'blue', UNCHANGED: 'gray', WARNING: 'amber', REJECTED: 'red' };
export const OUT_LABEL: Record<string, string> = { CREATED: 'Create', UPDATED: 'Update', UNCHANGED: 'Unchanged', WARNING: 'Warning', REJECTED: 'Rejected' };

const g = (r: ImportAssetRow, k: string) => (r.data[k] ?? '').trim();
/** "South/Kerala/Kochi" → "South / Kerala / Kochi", the form the register uses. */
const locPath = (s: string) => s ? s.split('/').map((x) => x.trim()).filter(Boolean).join(' / ') : null;

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
    if (/^Serial number is required/.test(m)) return `Required for ${g(r, 'category')}.`;
  }
  return null;
}

/**
 * The asset import preview in the asset register's own columns, so a row reads the same before
 * and after it is imported. The row number and result lead, with the reason beneath when there is one.
 */
export function importAssetColumns(): Column<ImportAssetRow>[] {
  return [
    { key: 'row', header: 'Row', className: 'align-top', render: (r) => {
      // New rows need no note: their location and holder already show in the columns.
      const notes = r.outcome === 'CREATED' ? [] : r.messages;
      return (
        <span className="flex flex-col items-start gap-1">
          <span className="flex items-center gap-2"><span className="text-slate-500">{r.rowNumber}</span><Badge tone={OUT_TONE[r.outcome]}>{OUT_LABEL[r.outcome]}</Badge></span>
          {notes.length > 0 && <span className={`block w-56 text-xs ${r.outcome === 'REJECTED' ? 'text-red-800' : r.outcome === 'WARNING' ? 'text-amber-800' : 'text-slate-600'}`}>{notes.join(' ')}</span>}
        </span>
      );
    } },
    { key: 'assetCode', header: 'Asset ID', className: 'align-top', render: (r) => {
      const a = r.view?.asset;
      return (
        <span className="block whitespace-nowrap">
          {a ? <Link href={`/assets/${a.id}`} className="font-semibold">{a.assetCode}</Link>
            : <span className="text-xs italic text-slate-400">{r.outcome === 'REJECTED' ? 'Not imported' : 'New, assigned on commit'}</span>}
          <span className="block text-xs text-slate-500">{g(r, 'category') || <Dash />}</span>
          {g(r, 'legacytag') && <span className="block text-[11px] text-slate-400">Legacy {g(r, 'legacytag')}</span>}
        </span>
      );
    } },
    { key: 'make', header: 'Make', className: 'align-top', render: (r) => <span className="whitespace-nowrap text-slate-600">{g(r, 'make') || <Dash />}</span> },
    { key: 'model', header: 'Model', className: 'align-top', render: (r) => <span className="block min-w-[6.5rem] font-medium text-slate-900">{g(r, 'model') || <Dash />}</span> },
    { key: 'serialNumber', header: 'Serial no.', className: 'align-top', render: (r) => {
      const serial = g(r, 'serialnumber');
      const problem = serialProblem(r);
      return (
        <span className="block">
          {serial ? <span className={problem ? 'whitespace-nowrap rounded bg-red-50 px-1 font-mono text-xs text-red-800 ring-1 ring-red-300' : 'whitespace-nowrap font-mono text-xs text-slate-700'}>{serial}</span> : <Dash />}
          {problem && <span className="mt-1 block min-w-[9rem] text-[11px] text-red-700">{problem}</span>}
        </span>
      );
    } },
    { key: 'hostname', header: 'Hostname', className: 'align-top', render: (r) => (g(r, 'hostname') || g(r, 'ipaddress') ? (
      <span className="block whitespace-nowrap">
        {g(r, 'hostname') || <Dash />}
        {g(r, 'ipaddress') && <span className="block font-mono text-[11px] text-slate-500">IP {g(r, 'ipaddress')}</span>}
      </span>
    ) : <Dash />) },
    { key: 'location', header: 'Location', className: 'align-top', render: (r) => <LocationCell path={locPath(g(r, 'location'))} /> },
    { key: 'holder', header: 'Assigned to', className: 'align-top', render: (r) => {
      const code = g(r, 'holderemployeeid');
      if (!code) return <HolderCell type={null} holder={null} />;
      return <HolderCell type="EMPLOYEE" holder={r.view?.holderName ? `${r.view.holderName} (${code})` : code} />;
    } },
    { key: 'status', header: 'Status', className: 'align-top', render: (r) => {
      if (r.view?.asset) return <AssetStatus s={r.view.asset.status} />;
      if (r.outcome === 'REJECTED') return <Dash />;
      return <AssetStatus s={g(r, 'holderemployeeid') ? 'ASSIGNED' : 'IN_STOCK'} />;
    } },
    { key: 'warrantyEnd', header: 'Warranty end', className: 'align-top', render: (r) => {
      const raw = g(r, 'warrantyend');
      const d = raw ? parseDate(raw) : null;
      return raw && !d ? <span className="text-xs text-red-700">{raw}</span> : <WarrantyCell end={d} />;
    } },
  ];
}
