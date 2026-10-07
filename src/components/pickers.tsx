'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, clearCachedApi, qs, useApi, useCachedApi } from './api';
import clsx from 'clsx';

export interface Loc { id: string; name: string; namePath: string; type: string; depth: number; active: boolean; assetCount: number; effectiveState: string | null; parentId: string | null; code: string | null; state: string | null; email: string | null }
export interface Cat { id: string; name: string; code: string | null; serialRequired: boolean; individuallyTracked: boolean; isSoftware: boolean; active: boolean; assetCount: number }
export interface Dept { id: string; name: string; active: boolean }

export const useLocations = (includeInactive = false, all = false) => useCachedApi<Loc[]>(`/api/locations${includeInactive || all ? '?' : ''}${includeInactive ? 'includeInactive=true&' : ''}${all ? 'all=true' : ''}`);
export const useCategories = () => useCachedApi<Cat[]>('/api/categories');
export const useDepartments = () => useCachedApi<Dept[]>('/api/departments');

/** Call after editing locations, categories or departments so every screen sees the change. */
export const refreshMasterData = () => { clearCachedApi('/api/locations'); clearCachedApi('/api/categories'); clearCachedApi('/api/departments'); };

export function LocationSelect({ value, onChange, placeholder = 'Choose a location', types, className, required, allowEmpty = true, id, all }: {
  value: string; onChange: (id: string) => void; placeholder?: string; types?: string[]; className?: string; required?: boolean; allowEmpty?: boolean; id?: string; all?: boolean;
}) {
  const { data } = useLocations(false, all);
  const rows = (data ?? []).filter((l) => !types || types.includes(l.type));
  return (
    <select id={id} className={clsx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {rows.map((l) => <option key={l.id} value={l.id}>{'  '.repeat(l.depth)}{l.name}{l.type !== 'BRANCH' ? ` (${l.type.toLowerCase()})` : ''}</option>)}
    </select>
  );
}

export function CategorySelect({ value, onChange, className, required, placeholder = 'Choose a category' }: { value: string; onChange: (id: string) => void; className?: string; required?: boolean; placeholder?: string }) {
  const { data } = useCategories();
  return (
    <select className={clsx('input', className)} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{placeholder}</option>
      {data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

export function DepartmentSelect({ value, onChange, className, placeholder = 'Choose a department' }: { value: string; onChange: (id: string) => void; className?: string; placeholder?: string }) {
  const { data } = useDepartments();
  return (
    <select className={clsx('input', className)} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

interface Emp { id: string; name: string; employeeCode: string; active: boolean; location?: { namePath: string } | null }

/** Type-ahead employee search (server-side, scoped). */
export function EmployeePicker({ value, onChange, activeOnly = true, placeholder = 'Search employee by name or ID' }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void; activeOnly?: boolean; placeholder?: string }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Emp[]>([]);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!open) return;
    clearTimeout(t.current);
    t.current = setTimeout(async () => {
      const r = await api<{ rows: Emp[] }>(`/api/employees${qs({ search: term, active: activeOnly ? 'true' : undefined, pageSize: 20 })}`).catch(() => ({ rows: [] }));
      setRows(r.rows);
    }, 200);
  }, [term, open, activeOnly]);
  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="input flex-1 truncate bg-slate-50">{value.label}</span>
        <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input className="input" placeholder={placeholder} value={term} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setTerm(e.target.value)} />
      {open && rows.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-white text-sm shadow-lg">
          {rows.map((e) => (
            <li key={e.id}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-slate-100" onMouseDown={() => { onChange({ id: e.id, label: `${e.name} (${e.employeeCode})` }); setTerm(''); }}>
                {e.name} <span className="text-slate-500">({e.employeeCode}){e.location ? ` · ${e.location.namePath}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type HolderValue = { type: 'EMPLOYEE' | 'DEPARTMENT' | 'LOCATION'; id: string; label: string } | null;

export function HolderPicker({ value, onChange }: { value: HolderValue; onChange: (v: HolderValue) => void }) {
  const [type, setType] = useState<'EMPLOYEE' | 'DEPARTMENT' | 'LOCATION'>(value?.type ?? 'EMPLOYEE');
  const { data: depts } = useDepartments();
  const { data: locs } = useLocations();
  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-sm">
        {(['EMPLOYEE', 'DEPARTMENT', 'LOCATION'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1"><input type="radio" checked={type === t} onChange={() => { setType(t); onChange(null); }} />{t === 'EMPLOYEE' ? 'Employee' : t === 'DEPARTMENT' ? 'Department' : 'Location'}</label>
        ))}
      </div>
      {type === 'EMPLOYEE' && <EmployeePicker value={value?.type === 'EMPLOYEE' ? value : null} onChange={(v) => onChange(v ? { type: 'EMPLOYEE', ...v } : null)} />}
      {type === 'DEPARTMENT' && (
        <select className="input" value={value?.type === 'DEPARTMENT' ? value.id : ''} onChange={(e) => { const d = depts?.find((x) => x.id === e.target.value); onChange(d ? { type: 'DEPARTMENT', id: d.id, label: d.name } : null); }}>
          <option value="">Choose a department</option>
          {depts?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )}
      {type === 'LOCATION' && (
        <select className="input" value={value?.type === 'LOCATION' ? value.id : ''} onChange={(e) => { const d = locs?.find((x) => x.id === e.target.value); onChange(d ? { type: 'LOCATION', id: d.id, label: d.namePath } : null); }}>
          <option value="">Choose a location</option>
          {locs?.map((d) => <option key={d.id} value={d.id}>{d.namePath}</option>)}
        </select>
      )}
    </div>
  );
}

interface U { id: string; name: string; email: string; role: string; active: boolean }
export function UserSelect({ value, onChange, roles, placeholder = 'Choose a user' }: { value: string; onChange: (id: string) => void; roles?: string[]; placeholder?: string }) {
  const { data } = useApi<{ rows: U[] }>('/api/users?pageSize=500&active=true');
  const rows = useMemo(() => (data?.rows ?? []).filter((u) => !roles || roles.includes(u.role)), [data, roles]);
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {rows.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
    </select>
  );
}
