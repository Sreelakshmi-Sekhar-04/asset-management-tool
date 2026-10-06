'use client';
import { ActiveFilters, DateRangeFilter, MultiOptionFilter, OptionFilter, SelectFilter, TextFilter, type ColumnFilterDef, type FilterChip } from './column-filter';
import type { useListState } from './list';
import { LocationSelect, useLocations } from './pickers';

type ListState = ReturnType<typeof useListState>;
type Opt = { value: string; label: string };

/**
 * Builders for column-heading filters on the simpler list pages. Each builder returns the
 * funnel for one column and records a removable chip for the strip above the table, so a page
 * only says which URL parameter each column filters on.
 * `defaults` are the list's default values: a parameter at its default shows no chip, and
 * clearing it sets `all` (so the default does not come back).
 */
export function useColumnFilters(ls: ListState, defaults: Record<string, string> = {}) {
  const { data: locs } = useLocations();
  const chips: FilterChip[] = [];
  // Every parameter a builder filters on, so "Clear all" resets only filters (not tabs or sorting).
  const keys = new Set<string>(['search']);
  const note = (...ks: string[]) => ks.forEach((k) => keys.add(k));
  const clear = (k: string) => ls.set(k, k in defaults ? 'all' : null);
  const isSet = (k: string) => !!ls.get(k) && ls.get(k) !== defaults[k] && ls.get(k) !== 'all';
  const optLabel = (opts: Opt[], v: string) => opts.find((o) => o.value === v)?.label ?? v;

  const text = (k: string, name: string, placeholder = `${name} contains…`): ColumnFilterDef => {
    note(k);
    if (isSet(k)) chips.push({ label: `${name}: “${ls.get(k)}”`, clear: () => clear(k) });
    return { active: isSet(k), content: (close) => <TextFilter value={ls.get(k)} placeholder={placeholder} onApply={(v) => ls.set(k, v)} close={close} /> };
  };
  const option = (k: string, name: string, opts: Opt[], allLabel = 'All'): ColumnFilterDef => {
    note(k);
    if (isSet(k)) chips.push({ label: `${name}: ${optLabel(opts, ls.get(k))}`, clear: () => clear(k) });
    return {
      active: isSet(k),
      content: (close) => <OptionFilter label={name} value={ls.get(k) === 'all' ? '' : ls.get(k)} options={opts} allLabel={allLabel} onChange={(v) => (v ? ls.set(k, v) : clear(k))} close={close} />,
    };
  };
  /** One of a fixed set with a default (no "All"): the default shows no chip and clearing returns to it. */
  const choice = (k: string, name: string, opts: Opt[], def: string): ColumnFilterDef => {
    note(k);
    const v = ls.get(k) || def;
    if (v !== def) chips.push({ label: `${name}: ${optLabel(opts, v)}`, clear: () => ls.set(k, null) });
    return {
      active: v !== def,
      content: (close) => <OptionFilter label={name} value={v === def ? '' : v} options={opts.filter((o) => o.value !== def)} allLabel={optLabel(opts, def)} onChange={(x) => ls.set(k, x)} close={close} />,
    };
  };
  const multi = (k: string, name: string, opts: Opt[]): ColumnFilterDef => {
    note(k);
    const vals = ls.getAll(k);
    if (vals.length) chips.push({ label: `${name}: ${vals.map((v) => optLabel(opts, v)).join(', ')}`, clear: () => ls.set(k, null) });
    return { active: vals.length > 0, content: (close) => <MultiOptionFilter label={name} values={vals} options={opts} onApply={(v) => ls.set(k, v)} close={close} /> };
  };
  const dates = (fromK: string, toK: string, name: string): ColumnFilterDef => {
    note(fromK, toK);
    const f = ls.get(fromK); const t = ls.get(toK);
    if (f || t) chips.push({ label: `${name}: ${f || '…'} to ${t || '…'}`, clear: () => ls.setMany({ [fromK]: null, [toK]: null }) });
    return { active: !!(f || t), content: (close) => <DateRangeFilter from={f} to={t} onApply={(a, b) => ls.setMany({ [fromK]: a, [toK]: b })} close={close} /> };
  };
  const location = (k: string, name = 'Location'): ColumnFilterDef => {
    note(k);
    if (ls.get(k)) chips.push({ label: `${name}: ${locs?.find((l) => l.id === ls.get(k))?.name ?? '…'}`, clear: () => ls.set(k, null) });
    return {
      active: !!ls.get(k),
      content: (close) => <SelectFilter label={`${name} (includes everything under it)`}><LocationSelect value={ls.get(k)} onChange={(v) => { ls.set(k, v); close(); }} placeholder="All locations" /></SelectFilter>,
    };
  };
  /** Several filters in one heading, e.g. a text box and an option list. */
  const both = (...defs: ColumnFilterDef[]): ColumnFilterDef => ({
    active: defs.some((d) => d.active),
    content: (close) => <>{defs.map((d, i) => <div key={i} className={i ? 'border-t pt-3' : undefined}>{d.content(close)}</div>)}</>,
  });
  /** Marks extra parameters (filtered by a hand-written funnel) as filters for "Clear all". */
  const track = note;
  const clearAll = () => ls.setMany(Object.fromEntries([...keys].map((k) => [k, k in defaults ? 'all' : null])));
  const strip = (right?: React.ReactNode) => <ActiveFilters chips={chips} onClearAll={clearAll} right={right} />;
  return { text, option, choice, multi, dates, location, both, track, chips, strip };
}
