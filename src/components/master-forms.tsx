'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { LocationSelect, UserSelect, type Dept, type Loc } from './pickers';
import { Field, FormModal } from './ui';

// Every location sits under an organization (head quarter). Organizations themselves are created
// under Configuration → Organizations, not here.
const TYPES = ['REGION', 'STATE', 'BRANCH', 'SITE', 'OTHER'];
export type LocationForm = { name: string; type: string; parentId: string; state: string; code: string; email: string; managerId: string };
export const emptyLocationForm = (p: Partial<LocationForm> = {}): LocationForm => ({ name: '', type: 'BRANCH', parentId: '', state: '', code: '', email: '', managerId: '', ...p });

/**
 * The Add / Edit location form, used on Configuration → Locations and, prefilled from the file,
 * by "Add location" in the Excel Upload preview. Calls onSaved with the saved location.
 */
export function LocationFormModal({ value, onClose, onSaved, intro }: {
  value: { id?: string; f: LocationForm } | null; onClose: () => void; onSaved: (l: Loc) => void | Promise<void>; intro?: ReactNode;
}) {
  const [f, setF] = useState<LocationForm | null>(value?.f ?? null);
  useEffect(() => { setF(value?.f ?? null); }, [value]);
  const set = (p: Partial<LocationForm>) => f && setF({ ...f, ...p });
  return (
    <FormModal open={!!value} onClose={onClose} title={value?.id ? 'Edit location' : 'Add location'}
      onSubmit={async () => {
        const body = { name: f!.name, type: f!.type, parentId: f!.parentId || null, state: f!.state || null, code: f!.code || null, email: f!.email || null, managerId: f!.managerId || null };
        const saved = value!.id ? await api<Loc>(`/api/locations/${value!.id}`, { method: 'PATCH', body }) : await api<Loc>('/api/locations', { body });
        await onSaved(saved);
      }}>
      {intro}
      {f && <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
        <Field label="Type"><select className="input" value={f.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</select></Field>
        <Field label="Parent" required hint={value?.id ? 'Changing the parent moves this location and everything beneath it' : undefined}><LocationSelect value={f.parentId} onChange={(parentId) => set({ parentId })} placeholder="Choose the parent" all required /></Field>
        <Field label="State" hint="Set on a state node or branch; used to flag inter-state transfers"><input className="input" value={f.state} onChange={(e) => set({ state: e.target.value })} /></Field>
        <Field label="Code"><input className="input" value={f.code} onChange={(e) => set({ code: e.target.value })} /></Field>
        <Field label="Branch email" hint="Receives transfer notifications"><input className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Location manager" className="sm:col-span-2" hint="Gives the second approval for transfers into this location, after an Administrator. Left empty, the manager of the location above it approves.">
          <UserSelect value={f.managerId} onChange={(managerId) => set({ managerId })} placeholder="Same as the location above" />
        </Field>
      </div>}
    </FormModal>
  );
}

/** The Add / Rename department form (Configuration → Categories and departments, and the Excel Upload preview). */
export function DepartmentFormModal({ value, onClose, onSaved, intro }: {
  value: { id?: string; name: string } | null; onClose: () => void; onSaved: (d: Dept) => void | Promise<void>; intro?: ReactNode;
}) {
  const [name, setName] = useState(value?.name ?? '');
  useEffect(() => { setName(value?.name ?? ''); }, [value]);
  return (
    <FormModal open={!!value} onClose={onClose} title={value?.id ? 'Rename department' : 'Add department'}
      onSubmit={async () => {
        const saved = value!.id ? await api<Dept>(`/api/departments/${value!.id}`, { method: 'PATCH', body: { name } }) : await api<Dept>('/api/departments', { body: { name } });
        await onSaved(saved);
      }}>
      {intro}
      {value && <Field label="Name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>}
    </FormModal>
  );
}
