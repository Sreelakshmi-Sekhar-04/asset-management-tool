'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from './api';
import { CategorySelect, LocationSelect, useCategories } from './pickers';
import { ErrorBox, Field } from './ui';

export interface AssetFormValues {
  categoryId: string; make: string; model: string; serialNumber: string; hostname: string; ipAddress: string; macAddress: string; legacyTag: string;
  purchaseDate: string; purchaseCost: string; vendor: string; warrantyEnd: string; condition: string; remarks: string; sdpTicketId: string; sdpTicketUrl: string; locationId: string;
}
export const emptyAsset: AssetFormValues = { categoryId: '', make: '', model: '', serialNumber: '', hostname: '', ipAddress: '', macAddress: '', legacyTag: '', purchaseDate: '', purchaseCost: '', vendor: '', warrantyEnd: '', condition: '', remarks: '', sdpTicketId: '', sdpTicketUrl: '', locationId: '' };

interface Match { key: string; value: string; severity: string; match: { id: string; assetCode: string; status: string; make: string; model: string; location: string | null } }

/** Duplicate handling (FR-REG-05): BLOCK shows the matching record; WARN asks for a reason, which is recorded. */
export function DuplicateNotice({ error, reason, setReason }: { error: unknown; reason: string; setReason: (v: string) => void }) {
  if (!(error instanceof ApiError) || (error.code !== 'DUPLICATE_WARNING' && error.code !== 'DUPLICATE_BLOCKED')) return <ErrorBox error={error} />;
  const matches = ((error.details as { matches?: Match[] })?.matches ?? []);
  const warn = error.code === 'DUPLICATE_WARNING';
  return (
    <div className={warn ? 'rounded-md border border-amber-300 bg-amber-50 p-3 text-sm' : 'rounded-md border border-red-300 bg-red-50 p-3 text-sm'}>
      <div className="font-medium">{error.message}</div>
      <ul className="mt-1 list-disc pl-5 text-xs">
        {matches.map((m, i) => <li key={i}><Link href={`/assets/${m.match.id}`} target="_blank">{m.match.assetCode}</Link> · {m.match.make} {m.match.model} · {m.match.status.replace('_', ' ').toLowerCase()} · {m.match.location ?? '—'}</li>)}
      </ul>
      {warn && <Field label="Reason for saving anyway" required className="mt-2"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>}
    </div>
  );
}

export function AssetFields({ v, set, mode, branchOnly }: { v: AssetFormValues; set: (patch: Partial<AssetFormValues>) => void; mode: 'create' | 'edit'; branchOnly?: boolean }) {
  const { data: cats } = useCategories();
  const cat = cats?.find((c) => c.id === v.categoryId);
  const dis = !!branchOnly;
  const inp = (k: keyof AssetFormValues, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input className="input" value={v[k]} onChange={(e) => set({ [k]: e.target.value })} disabled={dis && !['hostname', 'ipAddress', 'macAddress', 'remarks'].includes(k)} {...props} />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Category" required><CategorySelect value={v.categoryId} onChange={(id) => set({ categoryId: id })} required /></Field>
      {mode === 'create' && <Field label="Location" required><LocationSelect value={v.locationId} onChange={(id) => set({ locationId: id })} required /></Field>}
      <Field label="Make" required>{inp('make', { required: true, maxLength: 120 })}</Field>
      <Field label="Model" required>{inp('model', { required: true, maxLength: 160 })}</Field>
      <Field label="Serial number" required={!!cat?.serialRequired} hint={cat?.serialRequired ? `Required for ${cat.name}` : 'Unique across all assets, including retired'}>{inp('serialNumber', { required: !!cat?.serialRequired, maxLength: 120 })}</Field>
      <Field label="Legacy tag">{inp('legacyTag', { maxLength: 80 })}</Field>
      <Field label="Hostname">{inp('hostname', { maxLength: 120 })}</Field>
      <Field label="IP address">{inp('ipAddress', { maxLength: 60, placeholder: 'e.g. 10.1.2.3' })}</Field>
      <Field label="MAC address">{inp('macAddress', { maxLength: 40, placeholder: 'AA:BB:CC:DD:EE:FF' })}</Field>
      <Field label="Condition">{inp('condition', { maxLength: 120 })}</Field>
      <Field label="Purchase date">{inp('purchaseDate', { type: 'date' })}</Field>
      <Field label="Purchase cost (₹)">{inp('purchaseCost', { type: 'number', min: 0, step: '0.01' })}</Field>
      <Field label="Vendor">{inp('vendor', { maxLength: 160 })}</Field>
      <Field label="Warranty end" hint="Creates and maintains a warranty renewable automatically">{inp('warrantyEnd', { type: 'date' })}</Field>
      <Field label="ServiceDesk Plus ticket ID" hint="Reference only; no integration">{inp('sdpTicketId', { maxLength: 60 })}</Field>
      <Field label="ServiceDesk Plus ticket URL">{inp('sdpTicketUrl', { type: 'url', maxLength: 500, placeholder: 'https://…' })}</Field>
      <Field label="Remarks" className="sm:col-span-2"><textarea className="input" rows={2} value={v.remarks} onChange={(e) => set({ remarks: e.target.value })} maxLength={2000} /></Field>
    </div>
  );
}

export function toPayload(v: AssetFormValues, fields?: (keyof AssetFormValues)[]) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (fields && !fields.includes(k as keyof AssetFormValues)) continue;
    out[k] = k === 'purchaseCost' ? (val === '' ? null : Number(val)) : val === '' ? null : val;
  }
  return out;
}

export function useDupReason() {
  return useState('');
}
