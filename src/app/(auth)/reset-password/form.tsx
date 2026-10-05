'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { ErrorBox, Field } from '@/components/ui';

export function ResetForm() {
  const sp = useSearchParams();
  const token = sp.get('token') ?? '';
  const invite = sp.get('invite') === '1';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<unknown>(null);
  if (!token) return <p className="text-sm">This link is incomplete. <Link href="/forgot-password">Request a new one</Link>.</p>;
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      if (pw !== pw2) { setErr(new Error('The two passwords do not match.')); return; }
      try { await api('/api/auth/reset', { body: { token, password: pw } }); window.location.href = '/login?reset=1'; } catch (x) { setErr(x); }
    }}>
      <h1 className="text-lg">{invite ? 'Welcome — set your password' : 'Choose a new password'}</h1>
      <p className="text-xs text-slate-500">At least 10 characters with upper- and lower-case letters, a digit and a symbol.</p>
      <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
      <Field label="Repeat password"><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
      <ErrorBox error={err} />
      <button className="btn btn-primary w-full">Set password</button>
    </form>
  );
}
