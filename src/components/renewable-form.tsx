'use client';
import { useEffect, useState } from 'react';
import { RENEWABLE_TYPE_LABEL } from '@/lib/labels';
import { api, ApiError } from './api';
import { EmployeePicker, UserSelect } from './pickers';
import { Field, FormModal } from './ui';

export interface RenewableValues { type: string; label: string; vendor: string; identifier: string; seats: string; startDate: string; expiryDate: string; renewalTermMonths: string; cost: string; ownerUserId: string; ownerEmployee: { id: string; label: string } | null; critical: boolean }
export const emptyRenewable: RenewableValues = { type: 'LICENCE', label: '', vendor: '', identifier: '', seats: '', startDate: '', expiryDate: '', renewalTermMonths: '', cost: '', ownerUserId: '', ownerEmployee: null, critical: false };

const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** Create (with an Asset ID) or edit a renewable (FR-REN-01/02). */
export function RenewableFormModal({ open, onClose, initial, assetCode, id, onSaved }: { open: boolean; onClose: () => void; initial?: RenewableValues; assetCode?: string; id?: string; onSaved: (r: { id: string }) => void }) {
  const [v, setV] = useState<RenewableValues>(initial ?? emptyRenewable);
  const [code, setCode] = useState(assetCode ?? '');
  useEffect(() => { if (open) { setV(initial ?? emptyRenewable); setCode(assetCode ?? ''); } }, [open, initial, assetCode]);
  const set = (k: keyof RenewableValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <FormModal open={open} onClose={onClose} title={id ? 'Edit renewable' : 'Add renewable'} wide submitLabel={id ? 'Save' : 'Add'}
      onSubmit={async () => {
        const body: Record<string, unknown> = {
          type: v.type, label: v.label, vendor: v.vendor || null, identifier: v.identifier || null, seats: num(v.seats), startDate: v.startDate || null, expiryDate: v.expiryDate,
          renewalTermMonths: num(v.renewalTermMonths), cost: num(v.cost), ownerUserId: v.ownerUserId || null, ownerEmployeeId: v.ownerEmployee?.id ?? null, critical: v.critical,
        };
        if (id) { await api(`/api/renewables/${id}`, { method: 'PATCH', body }); onSaved({ id }); return; }
        if (!code.trim()) throw new ApiError(400, 'VALIDATION', 'Enter the Asset ID this renewable belongs to.');
        const a = await api<{ id: string }>(`/api/assets/lookup?q=${encodeURIComponent(code.trim())}`);
        onSaved(await api<{ id: string }>('/api/renewables', { body: { ...body, assetId: a.id } }));
      }}>
      <div className="grid gap-3 sm:grid-cols-3">
        {!id && <Field label="Asset ID" required><input className="input" value={code} onChange={(e) => setCode(e.target.value)} required disabled={!!assetCode} /></Field>}
        <Field label="Type" required><select className="input" value={v.type} onChange={set('type')} disabled={!!id}>{Object.entries(RENEWABLE_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Name" required className={id ? 'sm:col-span-2' : ''}><input className="input" value={v.label} onChange={set('label')} required placeholder="e.g. FortiGuard UTP bundle" /></Field>
        <Field label="Vendor"><input className="input" value={v.vendor} onChange={set('vendor')} /></Field>
        <Field label="Licence key / contract no."><input className="input" value={v.identifier} onChange={set('identifier')} /></Field>
        <Field label="Seats"><input className="input" type="number" min={1} value={v.seats} onChange={set('seats')} /></Field>
        <Field label="Start date"><input className="input" type="date" value={v.startDate} onChange={set('startDate')} /></Field>
        <Field label="Expiry date" required><input className="input" type="date" value={v.expiryDate} onChange={set('expiryDate')} required /></Field>
        <Field label="Renewal term (months)"><input className="input" type="number" min={1} value={v.renewalTermMonths} onChange={set('renewalTermMonths')} /></Field>
        <Field label="Cost (₹)"><input className="input" type="number" min={0} step="0.01" value={v.cost} onChange={set('cost')} /></Field>
        <Field label="Owner (user)"><UserSelect value={v.ownerUserId} onChange={(ownerUserId) => setV({ ...v, ownerUserId })} placeholder="None" /></Field>
        <Field label="Owner (employee)" hint="Used when the owner has no login"><EmployeePicker value={v.ownerEmployee} onChange={(ownerEmployee) => setV({ ...v, ownerEmployee })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.critical} onChange={(e) => setV({ ...v, critical: e.target.checked })} />Critical (highlighted on the dashboard and in reminders)</label>
    </FormModal>
  );
}
