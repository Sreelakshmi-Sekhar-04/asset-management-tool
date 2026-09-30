'use client';
import { useState } from 'react';
import { APPROVAL_ACTION_LABEL, ROLE_LABEL } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { useMe } from '@/components/me';
import { useCategories, UserSelect } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';

interface Step { stepOrder: number; approverType: 'USER' | 'ROLE' | 'HOLDER_MANAGER'; approverUserId: string | null; approverRole: string | null }
interface Policy { id: string; name: string; action: string; priority: number; active: boolean; categoryIds: string[]; minCost: string | number | null; minQuantity: number | null; interState: boolean | null; initiatorRoles: string[]; steps: Step[] }
type Form = Omit<Policy, 'id' | 'minCost' | 'minQuantity' | 'priority'> & { minCost: string; minQuantity: string; priority: string };
const blank: Form = { name: '', action: 'TRANSFER', priority: '100', active: true, categoryIds: [], minCost: '', minQuantity: '', interState: null, initiatorRoles: [], steps: [{ stepOrder: 1, approverType: 'ROLE', approverUserId: null, approverRole: 'ADMIN' }] };

export default function ApprovalPoliciesPage() {
  const me = useMe();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const { data, error, reload } = useApi<Policy[]>('/api/approval-policies');
  const { data: cats } = useCategories();
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const catName = (id: string) => cats?.find((c) => c.id === id)?.name ?? '?';
  const f = edit?.f;
  const set = (p: Partial<Form>) => edit && setEdit({ ...edit, f: { ...edit.f, ...p } });
  const setStep = (i: number, p: Partial<Step>) => f && set({ steps: f.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const describe = (p: Policy) => [
    p.categoryIds.length ? `category ${p.categoryIds.map(catName).join(' or ')}` : null,
    p.minCost !== null ? `any asset costing ₹${Number(p.minCost).toLocaleString('en-IN')} or more` : null,
    p.minQuantity ? `${p.minQuantity}+ assets` : null,
    p.interState === true ? 'inter-state' : p.interState === false ? 'within one state' : null,
    p.initiatorRoles.length ? `started by ${p.initiatorRoles.map((r) => ROLE_LABEL[r]).join(' or ')}` : null,
  ].filter(Boolean).join(', ') || 'every request';
  const stepText = (s: Step) => s.approverType === 'ROLE' ? `any ${ROLE_LABEL[s.approverRole ?? '']}` : s.approverType === 'HOLDER_MANAGER' ? 'holder’s manager (falls back to Administrator)' : 'named user';
  return (
    <div className="space-y-4">
      {node}
      <PageHeader title="Approval policies" subtitle="When an action matches an active policy it waits for approval before it takes effect. The first matching policy by priority applies; with no match the action happens immediately."
        actions={me.isAdmin && <button className="btn btn-primary" onClick={() => setEdit({ f: blank })}>Add policy</button>} />
      <ErrorBox error={error} />
      {!data ? <div className="flex justify-center py-10"><Spinner /></div> : Object.entries(APPROVAL_ACTION_LABEL).map(([action, label]) => {
        const ps = data.filter((p) => p.action === action);
        return (
          <Card key={action} title={label}>
            {ps.length === 0 ? <p className="text-sm text-slate-500">No policy: happens immediately.</p> : (
              <div className="space-y-2">{ps.map((p) => (
                <div key={p.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm">
                  <div>
                    <div className="font-medium">{p.name} <span className="text-xs text-slate-500">priority {p.priority}</span> {!p.active && <Badge>Inactive</Badge>}</div>
                    <div className="text-slate-600">Applies to {describe(p)}.</div>
                    <div className="text-xs text-slate-500">Steps: {p.steps.map((s) => `${s.stepOrder}. ${stepText(s)}`).join(' → ')}</div>
                  </div>
                  {me.isAdmin && <div className="flex gap-1">
                    <button className="btn btn-sm" onClick={() => setEdit({ id: p.id, f: { ...p, priority: String(p.priority), minCost: p.minCost === null ? '' : String(p.minCost), minQuantity: p.minQuantity === null ? '' : String(p.minQuantity) } })}>Edit</button>
                    <button className="btn btn-sm btn-ghost text-red-600" onClick={async () => { if (await confirm(`Delete policy “${p.name}”? Requests already pending keep going.`)) { await api(`/api/approval-policies/${p.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err')); reload(); } }}>Delete</button>
                  </div>}
                </div>
              ))}</div>
            )}
          </Card>
        );
      })}
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit policy' : 'Add policy'} wide
        onSubmit={async () => {
          const body = { ...f!, priority: Number(f!.priority) || 100, minCost: f!.minCost ? Number(f!.minCost) : null, minQuantity: f!.minQuantity ? Number(f!.minQuantity) : null, steps: f!.steps.map((s, i) => ({ ...s, stepOrder: i + 1 })) };
          if (edit!.id) await api(`/api/approval-policies/${edit!.id}`, { method: 'PUT', body }); else await api('/api/approval-policies', { body });
          toast('Saved'); reload();
        }}>
        {f && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" required className="sm:col-span-2"><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
            <Field label="Action"><select className="input" value={f.action} onChange={(e) => set({ action: e.target.value })}>{Object.entries(APPROVAL_ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Priority" hint="Lower runs first"><input className="input" type="number" min={1} value={f.priority} onChange={(e) => set({ priority: e.target.value })} /></Field>
            <Field label="Minimum single-asset cost (₹)"><input className="input" type="number" min={0} value={f.minCost} onChange={(e) => set({ minCost: e.target.value })} /></Field>
            <Field label="Minimum number of assets"><input className="input" type="number" min={1} value={f.minQuantity} onChange={(e) => set({ minQuantity: e.target.value })} /></Field>
            {f.action === 'TRANSFER' && <Field label="Transfer route"><select className="input" value={f.interState === null ? '' : String(f.interState)} onChange={(e) => set({ interState: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">Any</option><option value="true">Inter-state only</option><option value="false">Within one state only</option></select></Field>}
            <Field label="Status"><select className="input" value={String(f.active)} onChange={(e) => set({ active: e.target.value === 'true' })}><option value="true">Active</option><option value="false">Inactive</option></select></Field>
          </div>
          <Field label="Only for categories (none = all)">
            <div className="flex flex-wrap gap-3 text-sm">{(cats ?? []).map((c) => <label key={c.id} className="flex items-center gap-1"><input type="checkbox" checked={f.categoryIds.includes(c.id)} onChange={(e) => set({ categoryIds: e.target.checked ? [...f.categoryIds, c.id] : f.categoryIds.filter((x) => x !== c.id) })} />{c.name}</label>)}</div>
          </Field>
          <Field label="Only when started by (none = anyone)">
            <div className="flex gap-3 text-sm">{Object.entries(ROLE_LABEL).map(([r, l]) => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={f.initiatorRoles.includes(r)} onChange={(e) => set({ initiatorRoles: e.target.checked ? [...f.initiatorRoles, r] : f.initiatorRoles.filter((x) => x !== r) })} />{l}</label>)}</div>
          </Field>
          <div>
            <div className="field-label">Approval steps, in order</div>
            <div className="space-y-2">{f.steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-sm">{i + 1}.</span>
                <select className="input w-auto" value={s.approverType} onChange={(e) => setStep(i, { approverType: e.target.value as Step['approverType'] })}><option value="ROLE">Anyone with role</option><option value="USER">Named user</option><option value="HOLDER_MANAGER">Holder’s manager</option></select>
                {s.approverType === 'ROLE' && <select className="input w-auto" value={s.approverRole ?? ''} onChange={(e) => setStep(i, { approverRole: e.target.value })}><option value="ADMIN">Administrator</option><option value="IT_OPERATOR">IT Operator</option></select>}
                {s.approverType === 'USER' && <div className="w-64"><UserSelect value={s.approverUserId ?? ''} onChange={(v) => setStep(i, { approverUserId: v || null })} roles={['ADMIN', 'IT_OPERATOR']} /></div>}
                {f.steps.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ steps: f.steps.filter((_, j) => j !== i) })}>Remove</button>}
              </div>
            ))}</div>
            <button type="button" className="btn btn-sm mt-2" onClick={() => set({ steps: [...f.steps, { stepOrder: f.steps.length + 1, approverType: 'ROLE', approverUserId: null, approverRole: 'ADMIN' }] })}>Add step</button>
            <p className="mt-1 text-xs text-slate-500">Requesters cannot approve their own requests (Administrators excepted).</p>
          </div>
        </>}
      </FormModal>
    </div>
  );
}
