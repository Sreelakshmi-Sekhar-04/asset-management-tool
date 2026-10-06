'use client';
import clsx from 'clsx';
import { fmtDateOnly } from '@/lib/format';
import { label, STATUS_LABEL } from '@/lib/labels';
import { type useListState } from './list';
import { MultiOptionFilter, OptionFilter, SelectFilter, TextFilter, type ColumnFilterDef, type FilterChip } from './column-filter';
import { LocationSelect, useCategories, useLocations } from './pickers';

type ListState = ReturnType<typeof useListState>;

const HOLDER_OPTS = [{ value: 'EMPLOYEE', label: 'Employee' }, { value: 'DEPARTMENT', label: 'Department' }, { value: 'LOCATION', label: 'Location' }, { value: 'NONE', label: 'No holder' }];
const FLAG_OPTS = [{ value: 'ANY', label: 'Any flag' }, { value: 'TRANSFER_EXCEPTION', label: 'Transfer exception' }, { value: 'MISSING', label: 'Missing' }, { value: 'DUPLICATE_SUSPECT', label: 'Duplicate-suspect' }];
const WARRANTY_OPTS = [{ value: '30', label: 'Ends ≤ 30 days' }, { value: '60', label: 'Ends ≤ 60 days' }, { value: '90', label: 'Ends ≤ 90 days' }, { value: 'expired', label: 'Expired' }];
const optLabel = (opts: { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;

type Opt = { value: string; label: string };

/**
 * Asset register filters, one per column heading (Excel-style). Returns the per-column filter
 * panels plus the chips for whatever is in effect. `search` is still honoured (older saved filters,
 * links from elsewhere) and shows as a chip.
 */
export function useAssetColumnFilters(ls: ListState) {
  const { data: cats } = useCategories();
  const { data: locs } = useLocations();
  const warranty = ls.get('warrantyWithinDays') || (ls.get('warrantyExpired') ? 'expired' : '');
  const statuses = ls.getAll('status');
  const statusOpts: Opt[] = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));
  const catOpts: Opt[] = (cats ?? []).map((c) => ({ value: c.id, label: c.name }));
  const text = (k: string, placeholder: string, hint?: string): ColumnFilterDef => ({
    active: !!ls.get(k),
    content: (close) => <TextFilter value={ls.get(k)} placeholder={placeholder} label={hint} onApply={(v) => ls.set(k, v)} close={close} />,
  });

  const filters: Record<string, ColumnFilterDef> = {
    assetCode: {
      active: !!ls.get('assetCode') || ls.getAll('categoryId').length > 0,
      content: (close) => <>
        <TextFilter value={ls.get('assetCode')} placeholder="Asset ID or legacy tag contains…" onApply={(v) => ls.set('assetCode', v)} close={close} />
        <div className="border-t pt-3"><OptionFilter label="Category" value={ls.get('categoryId')} options={catOpts} allLabel="All categories" onChange={(v) => ls.set('categoryId', v)} close={close} /></div>
      </>,
    },
    make: text('make', 'Make contains…'),
    model: text('model', 'Model contains…'),
    serialNumber: text('serial', 'Serial contains…'),
    hostname: text('hostname', 'Hostname or IP contains…'),
    location: {
      active: !!ls.get('locationId'),
      content: (close) => (
        <SelectFilter label="Location (includes everything under it)">
          <LocationSelect value={ls.get('locationId')} onChange={(v) => { ls.set('locationId', v); close(); }} placeholder="All locations" />
        </SelectFilter>
      ),
    },
    holder: {
      active: !!ls.get('holder') || !!ls.get('holderType'),
      content: (close) => <>
        <TextFilter value={ls.get('holder')} placeholder="Name, employee code or department…" onApply={(v) => ls.set('holder', v)} close={close} />
        <div className="border-t pt-3"><OptionFilter label="Holder type" value={ls.get('holderType')} options={HOLDER_OPTS} allLabel="Any holder" onChange={(v) => ls.set('holderType', v)} close={close} /></div>
      </>,
    },
    status: {
      active: statuses.length > 0 || !!ls.get('flag'),
      content: (close) => <>
        <MultiOptionFilter label="Status" values={statuses} options={statusOpts} onApply={(v) => ls.set('status', v)} close={close} />
        <div className="border-t pt-3"><OptionFilter label="Flag" value={ls.get('flag')} options={FLAG_OPTS} allLabel="No flag filter" onChange={(v) => ls.set('flag', v)} close={close} /></div>
      </>,
    },
    warrantyEnd: {
      active: !!warranty,
      content: (close) => (
        <OptionFilter label="Warranty" value={warranty} options={WARRANTY_OPTS} allLabel="Any warranty"
          onChange={(v) => ls.setMany({ warrantyWithinDays: v && v !== 'expired' ? v : null, warrantyExpired: v === 'expired' ? 'true' : null })} close={close} />
      ),
    },
  };

  const chips: FilterChip[] = [];
  const chip = (k: string, name: string) => { if (ls.get(k)) chips.push({ label: `${name}: “${ls.get(k)}”`, clear: () => ls.set(k, null) }); };
  if (ls.get('search')) chips.push({ label: `Search: “${ls.get('search')}”`, clear: () => ls.set('search', null) });
  chip('assetCode', 'Asset ID');
  if (ls.getAll('categoryId').length) chips.push({ label: `Category: ${ls.getAll('categoryId').map((id) => cats?.find((c) => c.id === id)?.name ?? '…').join(', ')}`, clear: () => ls.set('categoryId', null) });
  chip('make', 'Make');
  chip('model', 'Model');
  chip('serial', 'Serial');
  chip('hostname', 'Hostname');
  if (ls.get('locationId')) chips.push({ label: `Location: ${locs?.find((l) => l.id === ls.get('locationId'))?.name ?? '…'}`, clear: () => ls.set('locationId', null) });
  chip('holder', 'Assigned to');
  if (ls.get('holderType')) chips.push({ label: `Holder: ${optLabel(HOLDER_OPTS, ls.get('holderType'))}`, clear: () => ls.set('holderType', null) });
  if (statuses.length) chips.push({ label: `Status: ${statuses.map((st) => label(STATUS_LABEL, st)).join(', ')}`, clear: () => ls.set('status', null) });
  if (ls.get('flag')) chips.push({ label: `Flag: ${optLabel(FLAG_OPTS, ls.get('flag'))}`, clear: () => ls.set('flag', null) });
  if (warranty) chips.push({ label: `Warranty: ${optLabel(WARRANTY_OPTS, warranty)}`, clear: () => ls.setMany({ warrantyWithinDays: null, warrantyExpired: null }) });
  if (ls.get('hasOpenTransfer')) chips.push({ label: ls.get('hasOpenTransfer') === 'true' ? 'In an open transfer' : 'Not in an open transfer', clear: () => ls.set('hasOpenTransfer', null) });

  return { filters, chips };
}

export const Dash = () => <span className="text-slate-300">—</span>;

/** "South / Kerala / Kochi" → Kochi in bold with "South · Kerala" beneath. */
export function LocationCell({ path }: { path: string | null }) {
  if (!path) return <Dash />;
  const parts = path.split(' / ');
  const name = parts.pop();
  return (
    <span className="block">
      <span className="text-slate-800">{name}</span>
      {parts.length > 0 && <span className="block text-[11px] text-slate-500">{parts.join(' · ')}</span>}
    </span>
  );
}

/** "Divya Patel (EMP1037)" → name with the employee code beneath; departments and locations are labelled. */
export function HolderCell({ type, holder }: { type: string | null; holder: string | null }) {
  if (!holder) return <span className="text-xs text-slate-400">Unassigned</span>;
  const m = type === 'EMPLOYEE' ? /^(.*) \(([^()]+)\)$/.exec(holder) : null;
  const name = m ? m[1] : type === 'LOCATION' ? holder.split(' / ').pop() : holder;
  const sub = m ? m[2] : type === 'DEPARTMENT' ? 'Department' : type === 'LOCATION' ? 'Location' : null;
  return (
    <span className="block min-w-[6.5rem]">
      <span className="text-slate-800">{name}</span>
      {sub && <span className="block text-[11px] text-slate-500">{sub}</span>}
    </span>
  );
}

export function WarrantyCell({ end }: { end: string | null }) {
  if (!end) return <Dash />;
  const days = Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000);
  const note = days < 0 ? { text: 'Expired', cls: 'text-red-600' } : days <= 90 ? { text: `Ends in ${days} day${days === 1 ? '' : 's'}`, cls: 'text-amber-600' } : null;
  return (
    <span className="block whitespace-nowrap">
      {fmtDateOnly(end)}
      {note && <span className={clsx('block text-[11px] font-medium', note.cls)}>{note.text}</span>}
    </span>
  );
}
