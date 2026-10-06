'use client';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { fmtDateOnly } from '@/lib/format';
import { label, STATUS_LABEL } from '@/lib/labels';
import { FilterSelect, SavedFilters, type useListState } from './list';
import { CategorySelect, LocationSelect, useCategories, useLocations } from './pickers';

type ListState = ReturnType<typeof useListState>;

const HOLDER_OPTS = [{ value: 'EMPLOYEE', label: 'Employee' }, { value: 'DEPARTMENT', label: 'Department' }, { value: 'LOCATION', label: 'Location' }, { value: 'NONE', label: 'No holder' }];
const FLAG_OPTS = [{ value: 'ANY', label: 'Any flag' }, { value: 'TRANSFER_EXCEPTION', label: 'Transfer exception' }, { value: 'MISSING', label: 'Missing' }, { value: 'DUPLICATE_SUSPECT', label: 'Duplicate-suspect' }];
const WARRANTY_OPTS = [{ value: '30', label: 'Ends ≤ 30 days' }, { value: '60', label: 'Ends ≤ 60 days' }, { value: '90', label: 'Ends ≤ 90 days' }, { value: 'expired', label: 'Expired' }];
const optLabel = (opts: { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;

/**
 * Asset register filters: search and the three most-used filters on one row; holder, flag and
 * warranty sit behind "More filters". Active filters show as removable chips.
 */
export function AssetFilterBar({ ls, onApplySaved }: { ls: ListState; onApplySaved: (q: string) => void }) {
  const warranty = ls.get('warrantyWithinDays') || (ls.get('warrantyExpired') ? 'expired' : '');
  const moreActive = [ls.get('holderType'), ls.get('flag'), warranty].filter(Boolean).length;
  const [more, setMore] = useState(moreActive > 0);
  const urlSearch = ls.get('search');
  const [search, setSearch] = useState(urlSearch);
  useEffect(() => { setSearch(urlSearch); }, [urlSearch]);
  const { data: cats } = useCategories();
  const { data: locs } = useLocations();
  const status = ls.getAll('status').length === 1 ? ls.get('status') : '';

  const chips: { label: string; clear: () => void }[] = [];
  if (ls.get('search')) chips.push({ label: `“${ls.get('search')}”`, clear: () => ls.set('search', null) });
  if (ls.get('categoryId')) chips.push({ label: `Category: ${cats?.find((c) => c.id === ls.get('categoryId'))?.name ?? '…'}`, clear: () => ls.set('categoryId', null) });
  if (ls.getAll('status').length) chips.push({ label: `Status: ${ls.getAll('status').map((s) => label(STATUS_LABEL, s)).join(', ')}`, clear: () => ls.set('status', null) });
  if (ls.get('locationId')) chips.push({ label: `Location: ${locs?.find((l) => l.id === ls.get('locationId'))?.name ?? '…'}`, clear: () => ls.set('locationId', null) });
  if (ls.get('holderType')) chips.push({ label: `Holder: ${optLabel(HOLDER_OPTS, ls.get('holderType'))}`, clear: () => ls.set('holderType', null) });
  if (ls.get('flag')) chips.push({ label: `Flag: ${optLabel(FLAG_OPTS, ls.get('flag'))}`, clear: () => ls.set('flag', null) });
  if (warranty) chips.push({ label: `Warranty: ${optLabel(WARRANTY_OPTS, warranty)}`, clear: () => ls.setMany({ warrantyWithinDays: null, warrantyExpired: null }) });

  return (
    <div className="card mb-3">
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <form className="relative min-w-[16rem] flex-[2_1_18rem]" onSubmit={(e) => { e.preventDefault(); ls.set('search', search.trim()); }}>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-slate-400">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.4 9.83l3.63 3.64a.75.75 0 1 0 1.06-1.06l-3.63-3.64A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" /></svg>
          </span>
          <input className="input pl-8" type="search" aria-label="Search assets" placeholder="Search Asset ID, serial, hostname, make, model, holder…"
            value={search} onChange={(e) => { setSearch(e.target.value); if (!e.target.value) ls.set('search', null); }} onBlur={() => search.trim() !== ls.get('search') && ls.set('search', search.trim())} />
        </form>
        <CategorySelect value={ls.get('categoryId')} onChange={(v) => ls.set('categoryId', v)} className="w-auto min-w-[9rem] flex-1 sm:max-w-[11rem]" placeholder="All categories" />
        <FilterSelect label="Status" value={status} onChange={(v) => ls.set('status', v)} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} className="min-w-[9rem] flex-1 sm:max-w-[10rem]" />
        <LocationSelect value={ls.get('locationId')} onChange={(v) => ls.set('locationId', v)} className="w-auto min-w-[9rem] flex-1 sm:max-w-[13rem]" placeholder="All locations" />
        <button type="button" className={clsx('btn', (more || moreActive > 0) && 'border-brand-500 text-brand-700')} aria-expanded={more} onClick={() => setMore((x) => !x)}>
          <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M3 5.25A.75.75 0 0 1 3.75 4.5h12.5a.75.75 0 0 1 0 1.5H3.75A.75.75 0 0 1 3 5.25Zm3 4.75a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 6 10Zm3 4.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75Z" /></svg>
          More filters{moreActive > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold text-white">{moreActive}</span>}
        </button>
      </div>
      {more && (
        <div className="grid gap-2 border-t bg-slate-50/70 px-2.5 py-2 sm:grid-cols-3">
          <FilterSelect label="Holder" value={ls.get('holderType')} onChange={(v) => ls.set('holderType', v)} options={HOLDER_OPTS} className="w-full" />
          <FilterSelect label="Flag" value={ls.get('flag')} onChange={(v) => ls.set('flag', v)} options={FLAG_OPTS} className="w-full" />
          <FilterSelect label="Warranty" value={warranty} onChange={(v) => ls.setMany({ warrantyWithinDays: v === 'expired' ? null : v, warrantyExpired: v === 'expired' ? 'true' : null })} options={WARRANTY_OPTS} className="w-full" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-2.5 py-1.5">
        <div className="flex min-h-[1.75rem] flex-wrap items-center gap-1.5 text-xs">
          {chips.length === 0 ? <span className="text-slate-400">Showing all assets</span> : <>
            {chips.map((c) => (
              <span key={c.label} className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 py-0.5 pl-2.5 pr-1 text-brand-900">
                {c.label}
                <button type="button" onClick={c.clear} aria-label={`Remove ${c.label}`} className="rounded-full px-1 text-brand-700 hover:bg-brand-100">✕</button>
              </span>
            ))}
            <button type="button" className="px-1 text-slate-500 underline hover:text-slate-700" onClick={ls.clear}>Clear all</button>
          </>}
        </div>
        <SavedFilters page="assets" query={ls.query} onApply={onApplySaved} />
      </div>
    </div>
  );
}

export const Dash = () => <span className="text-slate-300">—</span>;

/** "West / Gujarat / Surat" → Surat in bold with "West · Gujarat" beneath. */
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
