'use client';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A filter that lives in a column heading (Excel-style): a funnel button that opens a small panel. */
export interface ColumnFilterDef {
  /** True when this column currently narrows the list; the funnel turns blue. */
  active: boolean;
  /** Panel body. Call `close` after applying a choice. */
  content: (close: () => void) => ReactNode;
}

const PANEL_W = 272;

export function ColumnFilterButton({ title, filter }: { title: string; filter: ColumnFilterDef }) {
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [narrow, setNarrow] = useState(false);
  const close = () => { setOpen(false); btn.current?.focus(); };

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setNarrow(window.innerWidth < 640);
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 8, window.innerWidth - PANEL_W - 8)) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>('[data-filter-body] :is(input, select, button)')?.focus(); }, [open, pos]);

  return (
    <>
      <button ref={btn} type="button" aria-label={`Filter ${title}`} aria-haspopup="dialog" aria-expanded={open} title={`Filter ${title}`}
        onClick={() => setOpen((x) => !x)}
        className={clsx('-my-1 inline-flex h-6 w-6 items-center justify-center rounded hover:bg-slate-200',
          filter.active ? 'bg-brand-100 text-brand-700' : 'text-slate-400 hover:text-slate-600', open && 'ring-1 ring-brand-500')}>
        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5"><path d="M2.75 3.5A.75.75 0 0 0 2.2 4.76l5.3 5.86v5.13c0 .28.16.54.41.67l2.5 1.25a.75.75 0 0 0 1.09-.67v-6.38l5.3-5.86a.75.75 0 0 0-.55-1.26H2.75Z" /></svg>
      </button>
      {open && pos && createPortal(
        <>
          {narrow && <div className="fixed inset-0 z-40 bg-slate-900/30" aria-hidden />}
          <div ref={panel} role="dialog" aria-label={`Filter ${title}`}
            className={clsx('fixed z-50 border bg-white text-sm normal-case tracking-normal text-slate-700 shadow-lg',
              narrow ? 'inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-xl p-4 pb-6' : 'rounded-lg p-3')}
            style={narrow ? undefined : { top: pos.top, left: pos.left, width: PANEL_W }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Filter {title}</span>
              <button type="button" className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close" onClick={close}>✕</button>
            </div>
            <div data-filter-body className="space-y-3">{filter.content(close)}</div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/** Free-text "contains" filter. Applies on Enter or the Apply button. */
export function TextFilter({ label, value, placeholder, onApply, close }: { label?: string; value: string; placeholder?: string; onApply: (v: string | null) => void; close: () => void }) {
  const [v, setV] = useState(value);
  const apply = () => { onApply(v.trim() || null); close(); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); apply(); }} className="space-y-2">
      {label && <span className="block text-xs text-slate-500">{label}</span>}
      <input className="input" type="search" placeholder={placeholder ?? 'Contains…'} value={v} onChange={(e) => setV(e.target.value)} aria-label={label ?? placeholder ?? 'Contains'} />
      <div className="flex justify-end gap-1.5">
        {value && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onApply(null); close(); }}>Clear</button>}
        <button type="submit" className="btn btn-sm btn-primary">Apply</button>
      </div>
    </form>
  );
}

/** Pick one option (or "All"). Applies on click. */
export function OptionFilter({ label, value, options, onChange, close, allLabel = 'All' }: {
  label?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string | null) => void; close: () => void; allLabel?: string;
}) {
  const opts = [{ value: '', label: allLabel }, ...options];
  return (
    <div>
      {label && <span className="mb-1 block text-xs text-slate-500">{label}</span>}
      <ul className="max-h-60 overflow-y-auto rounded-md border" role="listbox" aria-label={label}>
        {opts.map((o) => (
          <li key={o.value}>
            <button type="button" role="option" aria-selected={o.value === value} onClick={() => { onChange(o.value || null); close(); }}
              className={clsx('flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50', o.value === value && 'bg-brand-50 font-medium text-brand-900')}>
              <span className="w-3 text-brand-600">{o.value === value ? '✓' : ''}</span>{o.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tick any number of options, then Apply. Nothing ticked = all. */
export function MultiOptionFilter({ label, values, options, onApply, close }: {
  label?: string; values: string[]; options: { value: string; label: string }[]; onApply: (v: string[] | null) => void; close: () => void;
}) {
  const [picked, setPicked] = useState(new Set(values));
  const toggle = (v: string) => setPicked((s) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n; });
  return (
    <div className="space-y-2">
      {label && <span className="block text-xs text-slate-500">{label}</span>}
      <ul className="max-h-60 overflow-y-auto rounded-md border py-1">
        {options.map((o) => (
          <li key={o.value}>
            <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-slate-50">
              <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} />{o.label}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-between gap-1.5">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>Clear ticks</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => { onApply(picked.size ? [...picked] : null); close(); }}>Apply</button>
      </div>
    </div>
  );
}

/** From / to date pair. */
export function DateRangeFilter({ from, to, onApply, close }: { from: string; to: string; onApply: (from: string | null, to: string | null) => void; close: () => void }) {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onApply(f || null, t || null); close(); }}>
      <label className="block text-xs text-slate-500">From<input type="date" className="input mt-0.5" value={f} onChange={(e) => setF(e.target.value)} /></label>
      <label className="block text-xs text-slate-500">To<input type="date" className="input mt-0.5" value={t} onChange={(e) => setT(e.target.value)} /></label>
      <div className="flex justify-end gap-1.5">
        {(from || to) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onApply(null, null); close(); }}>Clear</button>}
        <button type="submit" className="btn btn-sm btn-primary">Apply</button>
      </div>
    </form>
  );
}

/** A dropdown (e.g. a location tree) that applies as soon as it changes. */
export function SelectFilter({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs text-slate-500">{label}<div className="mt-0.5">{children}</div></label>;
}

export interface FilterChip { label: string; clear: () => void }

/**
 * Slim strip above the table: the filters in effect as removable chips, plus the saved-filters menu.
 * Replaces the old filter bar now that each filter lives in its column heading.
 */
export function ActiveFilters({ chips, onClearAll, right }: { chips: FilterChip[]; onClearAll: () => void; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
      <div className="flex min-h-[1.75rem] flex-wrap items-center gap-1.5 text-xs">
        {chips.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-slate-400">
            No filters. Use the
            <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3"><path d="M2.75 3.5A.75.75 0 0 0 2.2 4.76l5.3 5.86v5.13c0 .28.16.54.41.67l2.5 1.25a.75.75 0 0 0 1.09-.67v-6.38l5.3-5.86a.75.75 0 0 0-.55-1.26H2.75Z" /></svg>
            in a column heading to filter.
          </span>
        ) : <>
          {chips.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1 rounded-full border border-brand-100 bg-brand-50 py-0.5 pl-2.5 pr-1 text-brand-900">
              {c.label}
              <button type="button" onClick={c.clear} aria-label={`Remove ${c.label}`} className="rounded-full px-1 text-brand-700 hover:bg-brand-100">✕</button>
            </span>
          ))}
          <button type="button" className="px-1 text-slate-500 underline hover:text-slate-700" onClick={onClearAll}>Clear all</button>
        </>}
      </div>
      {right}
    </div>
  );
}
