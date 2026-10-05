'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/components/api';
import { ErrorBox, Field } from '@/components/ui';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return done ? (
    <div className="space-y-3 text-sm">
      <h1 className="text-lg">Check your email</h1>
      <p>If an account exists for <b>{email}</b>, a reset link has been sent. It is valid for one hour and can be used once.</p>
      <Link href="/login">Back to sign in</Link>
    </div>
  ) : (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await api('/api/auth/forgot', { body: { email } }); setDone(true); } catch (x) { setErr(x); } }}>
      <h1 className="text-lg">Reset your password</h1>
      <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
      <ErrorBox error={err} />
      <button className="btn btn-primary w-full">Send reset link</button>
      <div className="text-center text-sm"><Link href="/login">Back to sign in</Link></div>
    </form>
  );
}
