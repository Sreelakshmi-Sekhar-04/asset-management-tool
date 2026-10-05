'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Card, Spinner } from '@/components/ui';

/** Target of a link-style QR code: finds the asset (within the user's scope) and opens it. */
export default function ScanLink() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const id = decodeURIComponent(code ?? '');
  useEffect(() => {
    api<{ id: string }>(`/api/assets/lookup?q=${encodeURIComponent(id)}`)
      .then((a) => router.replace(`/assets/${a.id}`))
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? `No asset "${id}" is in your scope. It may belong to another branch.` : 'The asset could not be opened just now. Try again.'));
  }, [id, router]);
  if (!err) return <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500"><Spinner />Opening {id}…</div>;
  return (
    <Card className="mx-auto max-w-md">
      <p className="text-sm">{err}</p>
      <div className="mt-3 flex gap-2"><Link className="btn btn-primary" href="/scan">Scan another</Link><Link className="btn" href="/assets">Asset register</Link></div>
    </Card>
  );
}
