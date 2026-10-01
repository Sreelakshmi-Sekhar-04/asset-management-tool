'use client';
import { useState } from 'react';
import { ROLE_LABEL } from '@/lib/labels';
import { api } from '@/components/api';
import { useMe } from '@/components/me';
import { Card, ErrorBox, Field, PageHeader, Spinner, useToast } from '@/components/ui';

export default function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const [v, setV] = useState({ current: '', next: '', confirm: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (v.next !== v.confirm) { setErr(new Error('The new passwords do not match.')); return; }
    setBusy(true);
    try { await api('/api/auth/change-password', { body: { current: v.current, next: v.next } }); toast('Password changed. Other sessions have been signed out.'); setV({ current: '', next: '', confirm: '' }); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Your account" />
      <Card title="Profile">
        <dl className="kv"><dt>Name</dt><dd>{me.name}</dd><dt>Email</dt><dd>{me.email}</dd><dt>Role</dt><dd>{ROLE_LABEL[me.role]}</dd><dt>Scope</dt><dd>{me.scopeName ?? 'All locations'}</dd></dl>
      </Card>
      <Card title="Change password">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Current password" required><input className="input" type="password" autoComplete="current-password" value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} required /></Field>
          <Field label="New password" required hint="Mixed case, a digit and a symbol; must not contain your email name"><input className="input" type="password" autoComplete="new-password" value={v.next} onChange={(e) => setV({ ...v, next: e.target.value })} required /></Field>
          <Field label="Confirm new password" required><input className="input" type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} required /></Field>
          <ErrorBox error={err} />
          <button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Change password</button>
        </form>
      </Card>
    </div>
  );
}
