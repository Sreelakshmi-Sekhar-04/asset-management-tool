'use client';
import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '@/lib/labels';
import { api } from './api';
import { EmployeePicker, LocationSelect } from './pickers';
import { Field, FormModal, useConfirm, useToast } from './ui';

/** Sign-in account fields; a user is optionally the same person as an employee (linked). */
export type UserForm = { email: string; name: string; role: string; locationId: string; employee: { id: string; label: string } | null };
export const blankUser: UserForm = { email: '', name: '', role: 'IT_OPERATOR', locationId: '', employee: null };

export function UserFormModal({ open, onClose, id, initial, onSaved }: { open: boolean; onClose: () => void; id?: string; initial?: UserForm; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<UserForm>(initial ?? blankUser);
  useEffect(() => { if (open) setF(initial ?? blankUser); }, [open, initial]);
  const set = (p: Partial<UserForm>) => setF((x) => ({ ...x, ...p }));
  return (
    <FormModal open={open} onClose={onClose} title={id ? 'Edit sign-in' : 'Add sign-in'} submitLabel={id ? 'Save' : 'Create and send invite'}
      onSubmit={async () => {
        const body = { email: f.email, name: f.name, role: f.role, locationId: f.role === 'BRANCH_USER' ? f.locationId || null : null, employeeId: f.employee?.id ?? null };
        if (id) await api(`/api/users/${id}`, { method: 'PATCH', body }); else await api('/api/users', { body: { ...body, sendInvite: true } });
        toast(id ? 'Saved' : 'Sign-in created; invite emailed');
        onSaved();
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" required><input className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} required /></Field>
        <Field label="Name" required><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
        <Field label="Role" required><select className="input" value={f.role} onChange={(e) => set({ role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {f.role === 'BRANCH_USER' && <Field label="Bound to location" required><LocationSelect value={f.locationId} onChange={(locationId) => set({ locationId })} all /></Field>}
      </div>
      <Field label="Same person as employee" hint="Links the sign-in to the employee record, so the person appears once in the list. Used for manager-based approvals and reminders."><EmployeePicker value={f.employee} onChange={(employee) => set({ employee })} /></Field>
      {!id && <p className="text-xs text-slate-500">The person receives an email link to set their own password. No password is ever sent by email.</p>}
      {id && <p className="text-xs text-slate-500">Changing role or location signs the person out of every session.</p>}
    </FormModal>
  );
}

export interface SignIn { userId: string; userEmail: string; active: boolean; locked: boolean; hasPassword: boolean }

/** Unlock, invite, reset password and (de)activate for one sign-in. */
export function useSignInActions(reload: () => void) {
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const post = async (s: SignIn, path: string, msg: string, question?: string) => {
    if (question && !(await confirm(question))) return;
    try { await api(`/api/users/${s.userId}/${path}`, { method: 'POST' }); toast(msg); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const setActive = async (s: SignIn, active: boolean) => {
    if (!active && !(await confirm(`Turn off sign-in for ${s.userEmail}? They are signed out immediately.`))) return;
    try { await api(`/api/users/${s.userId}`, { method: 'PATCH', body: { active } }); toast(active ? 'Sign-in turned on' : 'Sign-in turned off'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const actions = (s: SignIn) => <>
    {s.locked && <button className="btn btn-sm" onClick={() => post(s, 'unlock', 'Unlocked')}>Unlock</button>}
    {!s.hasPassword ? <button className="btn btn-sm" onClick={() => post(s, 'invite', 'Invite sent')}>Resend invite</button>
      : <button className="btn btn-sm" onClick={() => post(s, 'reset-password', 'Reset link emailed', `Email ${s.userEmail} a password reset link?`)}>Reset password</button>}
    {s.active ? <button className="btn btn-sm btn-ghost text-red-600" onClick={() => setActive(s, false)}>Turn off sign-in</button> : <button className="btn btn-sm" onClick={() => setActive(s, true)}>Turn on sign-in</button>}
  </>;
  return { actions, node };
}
