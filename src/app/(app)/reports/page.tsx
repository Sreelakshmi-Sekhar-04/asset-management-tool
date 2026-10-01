'use client';
import Link from 'next/link';
import { useApi } from '@/components/api';
import { ErrorBox, PageHeader, Spinner } from '@/components/ui';

interface R { key: string; title: string; description: string }

export default function ReportsPage() {
  const { data, error } = useApi<R[]>('/api/reports');
  return (
    <div className="space-y-4">
      <PageHeader title="Reports" subtitle="Every report is scoped to your locations. What you see on screen is exactly what exports." />
      <ErrorBox error={error} />
      {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((r) => (
            <Link key={r.key} href={`/reports/${r.key}`} className="card card-body block no-underline hover:border-brand-400 hover:no-underline">
              <div className="font-medium text-slate-900">{r.title}</div>
              <div className="mt-1 text-sm text-slate-600">{r.description}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
