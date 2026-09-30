'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { api, qs, useApi } from './api';
import { Empty, Spinner, useToast } from './ui';

/** List state lives in the URL, so views are shareable, restorable and exportable as-is (FR-RPT-03). */
export function useListState(defaults: Record<string, string> = {}) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = useCallback((k: string) => sp.get(k) ?? defaults[k] ?? '', [sp, defaults]);
  const getAll = useCallback((k: string) => sp.getAll(k).flatMap((v) => v.split(',')).filter(Boolean), [sp]);
  const setMany = useCallback((vals: Record<string, string | string[] | null | undefined>, resetPage = true) => {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(vals)) {
      u.delete(k);
      if (Array.isArray(v)) v.filter(Boolean).forEach((x) => u.append(k, x));
      else if (v !== null && v !== undefined && v !== '') u.set(k, v);
    }
    if (resetPage && !('page' in vals)) u.delete('page');
    router.replace(`${pathname}${u.toString() ? `?${u}` : ''}`, { scroll: false });
  }, [sp, router, pathname]);
  const set = useCallback((k: string, v: string | string[] | null | undefined) => setMany({ [k]: v }), [setMany]);
  const query = sp.toString();
  const page = Number(sp.get('page') ?? 1) || 1;
  const pageSize = Number(sp.get('pageSize') ?? defaults.pageSize ?? 50) || 50;
  const sort = sp.get('sort') ?? defaults.sort ?? '';
  const dir = (sp.get('dir') ?? defaults.dir ?? 'asc') as 'asc' | 'desc';
  /** Query string for the API, merged with defaults (defaults apply only when the URL lacks the key). */
  const apiQuery = useMemo(() => {
    const u = new URLSearchParams(query);
    for (const [k, v] of Object.entries(defaults)) if (!u.has(k) && v) u.set(k, v);
    return u.toString();
  }, [query, defaults]);
  return { get, getAll, set, setMany, query, apiQuery, page, pageSize, sort, dir, clear: () => router.replace(pathname, { scroll: false }) };
}

export interface Column<T> { key: string; header: ReactNode; render?: (row: T) => ReactNode; sortable?: boolean; className?: string }

export type Selection = { mode: 'ids'; ids: Set<string> } | { mode: 'all'; exclude: Set<string> };
export const emptySelection = (): Selection => ({ mode: 'ids', ids: new Set() });
export const selectionCount = (s: Selection, total: number) => (s.mode === 'ids' ? s.ids.size : total - s.exclude.size);
export const isSelected = (s: Selection, id: string) => (s.mode === 'ids' ? s.ids.has(id) : !s.exclude.has(id));

export function DataTable<T extends { id?: string }>({
  columns, rows, total, loading, page, pageSize, sort, dir, onPage, onSort, selection, onSelection, rowKey, empty, onPageSize,
}: {
  columns: Column<T>[]; rows: T[]; total: number; loading?: boolean; page: number; pageSize: number; sort?: string; dir?: 'asc' | 'desc';
  onPage: (p: number) => void; onSort?: (key: string, dir: 'asc' | 'desc') => void; onPageSize?: (n: number) => void;
  selection?: Selection; onSelection?: (s: Selection) => void; rowKey?: (r: T) => string; empty?: ReactNode;
}) {
  const key = rowKey ?? ((r: T) => r.id as string);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageIds = rows.map(key);
  const allOnPage = !!selection && pageIds.length > 0 && pageIds.every((id) => isSelected(selection, id));
  const count = selection ? selectionCount(selection, total) : 0;
  const togglePage = () => {
    if (!selection || !onSelection) return;
    if (selection.mode === 'ids') {
      const ids = new Set(selection.ids);
      pageIds.forEach((id) => (allOnPage ? ids.delete(id) : ids.add(id)));
      onSelection({ mode: 'ids', ids });
    } else {
      const ex = new Set(selection.exclude);
      pageIds.forEach((id) => (allOnPage ? ex.add(id) : ex.delete(id)));
      onSelection({ mode: 'all', exclude: ex });
    }
  };
  const toggle = (id: string) => {
    if (!selection || !onSelection) return;
    if (selection.mode === 'ids') { const ids = new Set(selection.ids); ids.has(id) ? ids.delete(id) : ids.add(id); onSelection({ mode: 'ids', ids }); }
    else { const ex = new Set(selection.exclude); ex.has(id) ? ex.delete(id) : ex.add(id); onSelection({ mode: 'all', exclude: ex }); }
  };
  return (
    <div className="card overflow-hidden">
      {selection && onSelection && count > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-brand-50 px-3 py-1.5 text-xs text-brand-900">
          <b>{count.toLocaleString('en-IN')} selected</b>
          {selection.mode === 'ids' && allOnPage && total > rows.length && (
            <button className="underline" onClick={() => onSelection({ mode: 'all', exclude: new Set() })}>Select all {total.toLocaleString('en-IN')} matching</button>
          )}
          <button className="underline" onClick={() => onSelection(emptySelection())}>Clear selection</button>
        </div>
      )}
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {selection && <th className="w-8"><input type="checkbox" aria-label="Select page" checked={allOnPage} onChange={togglePage} /></th>}
              {columns.map((c) => (
                <th key={c.key} className={c.className}>
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase" onClick={() => onSort(c.key, sort === c.key && dir === 'asc' ? 'desc' : 'asc')}>
                      {c.header}{sort === c.key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={key(r)} className={clsx(selection && isSelected(selection, key(r)) && 'bg-brand-50/60')}>
                {selection && <td><input type="checkbox" aria-label="Select row" checked={isSelected(selection, key(r))} onChange={() => toggle(key(r))} /></td>}
                {columns.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && rows.length === 0 && <div className="flex justify-center py-10"><Spinner /></div>}
        {!loading && rows.length === 0 && <Empty>{empty ?? 'No records match.'}</Empty>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-slate-600">
        <span>{total.toLocaleString('en-IN')} record{total === 1 ? '' : 's'}{loading && rows.length > 0 && <Spinner className="ml-2 h-3 w-3 align-middle" />}</span>
        <div className="flex items-center gap-2">
          {onPageSize && (
            <select className="input w-auto py-0.5 text-xs" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page">
              {[25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
          )}
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
          <span>Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

/** Save and reapply named filters for a page (FR-RPT-03). */
export function SavedFilters({ page, query, onApply }: { page: string; query: string; onApply: (q: string) => void }) {
  const { data, reload } = useApi<{ id: string; name: string; query: Record<string, string | string[]> }[]>(`/api/saved-filters${qs({ page })}`);
  const toast = useToast();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const save = async () => {
    const q: Record<string, string | string[]> = {};
    const u = new URLSearchParams(query);
    for (const k of new Set(u.keys())) { if (k === 'page') continue; const all = u.getAll(k); q[k] = all.length > 1 ? all : all[0]; }
    await api('/api/saved-filters', { body: { page, name, query: q } });
    setName(''); setOpen(false); toast('Filter saved'); reload();
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select className="input w-auto py-1 text-xs" value="" onChange={(e) => {
        const f = data?.find((x) => x.id === e.target.value);
        if (f) { const u = new URLSearchParams(); for (const [k, v] of Object.entries(f.query)) (Array.isArray(v) ? v : [v]).forEach((x) => u.append(k, x)); onApply(u.toString()); }
      }} aria-label="Saved filters">
        <option value="">Saved filters{data?.length ? ` (${data.length})` : ''}</option>
        {data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      {open ? (
        <span className="flex items-center gap-1">
          <input className="input w-36 py-1 text-xs" placeholder="Filter name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-sm" disabled={!name.trim()} onClick={() => save().catch((e) => toast(e.message, 'err'))}>Save</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>✕</button>
        </span>
      ) : <button className="btn btn-sm" onClick={() => setOpen(true)}>Save current filter</button>}
      {data && data.length > 0 && (
        <details className="relative text-xs">
          <summary className="cursor-pointer text-slate-500">Manage</summary>
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border bg-white p-2 shadow">
            {data.map((f) => (
              <div key={f.id} className="flex items-center justify-between py-0.5">
                <span className="truncate">{f.name}</span>
                <button className="text-red-600" onClick={async () => { await api(`/api/saved-filters/${f.id}`, { method: 'DELETE' }); reload(); }}>Delete</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onChange(v.trim()); }} className="flex min-w-[14rem] flex-1 gap-1">
      <input className="input" type="search" placeholder={placeholder ?? 'Search'} value={v} onChange={(e) => { setV(e.target.value); if (!e.target.value) onChange(''); }} />
      <button className="btn">Search</button>
    </form>
  );
}

export function FilterSelect({ label, value, onChange, options, className }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select className={clsx('input w-auto', className)} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function LinkCell({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="font-medium">{children}</Link>;
}
