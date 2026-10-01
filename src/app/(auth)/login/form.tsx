'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { ErrorBox, Field, Spinner } from '@/components/ui';

export function LoginForm() {
  const sp = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/api/auth/login', { body: { email, password } });
      const next = sp.get('next');
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (x) { setErr(x); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <h1 className="text-lg">Sign in</h1>
      {sp.get('expired') && !err && <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">Please sign in to continue.</div>}
      {sp.get('reset') && <div className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">Password set. Sign in with your new password.</div>}
      <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
      <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      <ErrorBox error={err} />
      <button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Sign in</button>
      <div className="text-center text-sm"><Link href="/forgot-password">Forgot password?</Link></div>
    </form>
  );
}
