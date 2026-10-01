'use client';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/labels';
import { api, qs, useApi } from '@/components/api';
import { DataTable, FilterSelect, SearchBox, useListState } from '@/components/list';
import { EmployeePicker, LocationSelect } from '@/components/pickers';
import { Badge, ErrorBox, Field, FormModal, PageHeader, useConfirm, useToast } from '@/components/ui';

interface U { id: string; email: string; name: string; role: string; active: boolean; lastLoginAt: string | null; lockedUntil: string | null; failedLoginCount: number; invitedAt: string | null; hasPassword: boolean; location: { id: string; namePath: string } | null; employee: { id: string; name: string; employeeCode: string } | null }
type Form = { email: string; name: string; role: string; locationId: string; employee: { id: string; label: string } | null; active: boolean };
const blank: Form = { email: '', name: '', role: 'IT_OPERATOR', locationId: '', employee: null, active: true };

function Inner() {
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const ls = useListState();
  const { data, error, loading, reload } = useApi<{ rows: U[]; total: number }>(`/api/users${qs({ search: ls.get('search'), role: ls.get('role'), active: ls.get('active'), page: ls.page, pageSize: ls.pageSize })}`);
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const act = async (u: U, path: string, msg: string, question?: string) => {
    if (question && !(await confirm(question))) return;
    try { await api(`/api/users/${u.id}/${path}`, { method: 'POST' }); toast(msg); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const setActive = async (u: U, active: boolean) => {
    if (!active && !(await confirm(`Deactivate ${u.email}? They are signed out immediately.`))) return;
    try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { active } }); toast(active ? 'Activated' : 'Deactivated'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const f = edit?.f;
  const set = (p: Partial<Form>) => edit && setEdit({ ...edit, f: { ...edit.f, ...p } });
  return (
    <div className="space-y-4">
      {node}
      <PageHeader title="Users" subtitle="Administrators and IT operators see every location. A branch user is bound to exactly one location and sees only it and what is beneath it."
        actions={<button className="btn btn-primary" onClick={() => setEdit({ f: blank })}>Add user</button>} />
      <div className="flex flex-wrap gap-2">
        <SearchBox value={ls.get('search')} onChange={(v) => ls.set('search', v)} placeholder="Name or email" />
        <FilterSelect label="Role" value={ls.get('role')} onChange={(v) => ls.set('role', v)} options={Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))} />
        <FilterSelect label="Status" value={ls.get('active')} onChange={(v) => ls.set('active', v)} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)}
        columns={[
          { key: 'email', header: 'User', render: (u) => <div><div className="font-medium">{u.name}</div><div className="text-xs text-slate-500">{u.email}</div></div> },
          { key: 'role', header: 'Role', render: (u) => ROLE_LABEL[u.role] },
          { key: 'scope', header: 'Scope', render: (u) => <span className="text-xs">{u.role === 'BRANCH_USER' ? u.location?.namePath : 'All locations'}</span> },
          { key: 'state', header: 'Status', render: (u) => <span className="flex flex-wrap gap-1">{u.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}{u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="red">Locked</Badge>}{!u.hasPassword && <Badge tone="amber">Invite pending</Badge>}</span> },
          { key: 'lastLoginAt', header: 'Last sign-in', className: 'whitespace-nowrap', render: (u) => u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never' },
          { key: 'actions', header: '', render: (u) => (
            <span className="flex flex-wrap justify-end gap-1">
              <button className="btn btn-sm" onClick={() => setEdit({ id: u.id, f: { email: u.email, name: u.name, role: u.role, locationId: u.location?.id ?? '', employee: u.employee ? { id: u.employee.id, label: `${u.employee.name} (${u.employee.employeeCode})` } : null, active: u.active } })}>Edit</button>
              {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <button className="btn btn-sm" onClick={() => act(u, 'unlock', 'Unlocked')}>Unlock</button>}
              {!u.hasPassword ? <button className="btn btn-sm" onClick={() => act(u, 'invite', 'Invite sent')}>Resend invite</button>
                : <button className="btn btn-sm" onClick={() => act(u, 'reset-password', 'Reset link emailed', `Email ${u.email} a password reset link?`)}>Reset password</button>}
              {u.active ? <button className="btn btn-sm btn-ghost text-red-600" onClick={() => setActive(u, false)}>Deactivate</button> : <button className="btn btn-sm" onClick={() => setActive(u, true)}>Activate</button>}
            </span>
          ) },
        ]} />
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit user' : 'Add user'} submitLabel={edit?.id ? 'Save' : 'Create and send invite'}
        onSubmit={async () => {
          const body = { email: f!.email, name: f!.name, role: f!.role, locationId: f!.role === 'BRANCH_USER' ? f!.locationId || null : null, employeeId: f!.employee?.id ?? null };
          if (edit!.id) await api(`/api/users/${edit!.id}`, { method: 'PATCH', body }); else await api('/api/users', { body: { ...body, sendInvite: true } });
          toast(edit!.id ? 'Saved' : 'User created; invite emailed'); reload();
        }}>
        {f && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email" required><input className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} required /></Field>
            <Field label="Name" required><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
            <Field label="Role" required><select className="input" value={f.role} onChange={(e) => set({ role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            {f.role === 'BRANCH_USER' && <Field label="Bound to location" required><LocationSelect value={f.locationId} onChange={(locationId) => set({ locationId })} all /></Field>}
          </div>
          <Field label="Linked employee" hint="Used for manager-based approvals and reminders"><EmployeePicker value={f.employee} onChange={(employee) => set({ employee })} /></Field>
          {!edit?.id && <p className="text-xs text-slate-500">The user receives an email link to set their own password. No password is ever sent by email.</p>}
          {edit?.id && <p className="text-xs text-slate-500">Changing role or location signs the user out of every session.</p>}
        </>}
      </FormModal>
    </div>
  );
}
export default function UsersPage() { return <Suspense><Inner /></Suspense>; }
