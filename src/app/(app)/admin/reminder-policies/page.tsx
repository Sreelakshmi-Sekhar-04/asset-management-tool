'use client';
import { useState } from 'react';
import { RENEWABLE_TYPE_LABEL, ROLE_LABEL } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useToast } from '@/components/ui';

interface P { id: string; name: string; types: string[]; leadDays: number[]; notifyOwner: boolean; notifyOwnerManager: boolean; roles: string[]; userIds: string[]; channelInApp: boolean; channelEmail: boolean; escalationDays: number | null; escalationRole: string | null; escalationUserIds: string[]; escalateToOwnerManager: boolean; priority: number; active: boolean }
type Form = Omit<P, 'id' | 'leadDays' | 'escalationDays' | 'priority'> & { leadDays: string; escalationDays: string; priority: string };
const blank: Form = { name: '', types: [], leadDays: '90, 30, 7, 1', notifyOwner: true, notifyOwnerManager: false, roles: ['IT_OPERATOR'], userIds: [], channelInApp: true, channelEmail: true, escalationDays: '7', escalationRole: 'ADMIN', escalationUserIds: [], escalateToOwnerManager: true, priority: '100', active: true };

export default function ReminderPoliciesPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<P[]>('/api/reminder-policies');
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const f = edit?.f;
  const set = (p: Partial<Form>) => edit && setEdit({ ...edit, f: { ...edit.f, ...p } });
  const toggleIn = (k: 'types' | 'roles', v: string, on: boolean) => f && set({ [k]: on ? [...f[k], v] : f[k].filter((x) => x !== v) } as Partial<Form>);
  return (
    <div className="space-y-4">
      <PageHeader title="Reminder policies" subtitle="Who is reminded before a warranty, licence or contract expires, and when. The first active policy matching the item’s type (by priority) applies; each reminder is sent once per renewal cycle."
        actions={<button className="btn btn-primary" onClick={() => setEdit({ f: blank })}>Add policy</button>} />
      <ErrorBox error={error} />
      {!data ? <div className="flex justify-center py-10"><Spinner /></div> : data.length === 0 ? <Card><p className="text-sm text-slate-500">No policies: the built-in default applies (90, 30, 7 and 1 days before; IT operators and the owner; escalation to Administrators after 7 days for critical items).</p></Card> : (
        <div className="space-y-2">{data.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
              <div>
                <div className="font-medium">{p.name} <span className="text-xs text-slate-500">priority {p.priority}</span> {!p.active && <Badge>Inactive</Badge>}</div>
                <div>Types: {p.types.length ? p.types.map((t) => RENEWABLE_TYPE_LABEL[t]).join(', ') : 'all'} · Reminders {p.leadDays.join(', ')} days before</div>
                <div className="text-xs text-slate-600">To: {[p.notifyOwner && 'owner', p.notifyOwnerManager && 'owner’s manager', ...p.roles.map((r) => ROLE_LABEL[r])].filter(Boolean).join(', ') || 'nobody'} · via {[p.channelInApp && 'in-app', p.channelEmail && 'email'].filter(Boolean).join(' and ')}</div>
                {p.escalationDays && <div className="text-xs text-slate-600">Critical items unacknowledged {p.escalationDays} days after the first reminder escalate to {[p.escalationRole && ROLE_LABEL[p.escalationRole], p.escalateToOwnerManager && 'owner’s manager'].filter(Boolean).join(' and ')}</div>}
              </div>
              <button className="btn btn-sm" onClick={() => setEdit({ id: p.id, f: { ...p, leadDays: p.leadDays.join(', '), escalationDays: p.escalationDays ? String(p.escalationDays) : '', priority: String(p.priority) } })}>Edit</button>
            </div>
          </Card>
        ))}</div>
      )}
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit reminder policy' : 'Add reminder policy'} wide
        onSubmit={async () => {
          const lead = f!.leadDays.split(/[,\s]+/).filter(Boolean).map(Number);
          if (lead.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('Reminder days must be whole numbers, e.g. 90, 30, 7, 1');
          const body = { ...f!, leadDays: lead, escalationDays: f!.escalationDays ? Number(f!.escalationDays) : null, escalationRole: f!.escalationRole || null, priority: Number(f!.priority) || 100 };
          if (edit!.id) await api(`/api/reminder-policies/${edit!.id}`, { method: 'PUT', body }); else await api('/api/reminder-policies', { body });
          toast('Saved'); reload();
        }}>
        {f && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" required className="sm:col-span-2"><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
            <Field label="Priority" hint="Lower runs first"><input className="input" type="number" min={1} value={f.priority} onChange={(e) => set({ priority: e.target.value })} /></Field>
            <Field label="Days before expiry" required hint="Comma-separated"><input className="input" value={f.leadDays} onChange={(e) => set({ leadDays: e.target.value })} required /></Field>
            <Field label="Status"><select className="input" value={String(f.active)} onChange={(e) => set({ active: e.target.value === 'true' })}><option value="true">Active</option><option value="false">Inactive</option></select></Field>
          </div>
          <Field label="Types (none = all)"><div className="flex flex-wrap gap-3 text-sm">{Object.entries(RENEWABLE_TYPE_LABEL).map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={f.types.includes(k)} onChange={(e) => toggleIn('types', k, e.target.checked)} />{l}</label>)}</div></Field>
          <Field label="Recipients"><div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.notifyOwner} onChange={(e) => set({ notifyOwner: e.target.checked })} />Owner</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.notifyOwnerManager} onChange={(e) => set({ notifyOwnerManager: e.target.checked })} />Owner’s manager</label>
            {Object.entries(ROLE_LABEL).map(([r, l]) => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={f.roles.includes(r)} onChange={(e) => toggleIn('roles', r, e.target.checked)} />{l}s{r === 'BRANCH_USER' ? ' (of the asset’s branch)' : ''}</label>)}
          </div></Field>
          <Field label="Channels"><div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.channelInApp} onChange={(e) => set({ channelInApp: e.target.checked })} />In-app</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={f.channelEmail} onChange={(e) => set({ channelEmail: e.target.checked })} />Email</label>
          </div></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Escalate critical items after (days)" hint="Blank = no escalation"><input className="input" type="number" min={1} value={f.escalationDays} onChange={(e) => set({ escalationDays: e.target.value })} /></Field>
            <Field label="Escalate to role"><select className="input" value={f.escalationRole ?? ''} onChange={(e) => set({ escalationRole: e.target.value || null })}><option value="">None</option><option value="ADMIN">Administrators</option><option value="IT_OPERATOR">IT Operators</option></select></Field>
            <label className="mt-6 flex items-center gap-1 text-sm"><input type="checkbox" checked={f.escalateToOwnerManager} onChange={(e) => set({ escalateToOwnerManager: e.target.checked })} />Also the owner’s manager</label>
          </div>
        </>}
      </FormModal>
    </div>
  );
}
