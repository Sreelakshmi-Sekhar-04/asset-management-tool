'use client';
import { Suspense } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { Badge, ErrorBox, PageHeader, useToast } from '@/components/ui';

interface E { id: string; to: string; subject: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string }
const TONE: Record<string, string> = { PENDING: 'blue', SENT: 'green', FAILED: 'red' };

function Inner() {
  const toast = useToast();
  const ls = useListState();
  const { data, error, loading, reload } = useApi<{ rows: E[]; total: number }>(`/api/admin/emails${qs({ status: ls.get('status'), page: ls.page, pageSize: ls.pageSize })}`);
  return (
    <div className="space-y-4">
      <PageHeader title="Email outbox" subtitle="Every email the system queues. Failed sends retry automatically with back-off; without SMTP configured, emails are logged instead of sent." />
      <FilterSelect label="Status" value={ls.get('status')} onChange={(v) => ls.set('status', v)} options={['PENDING', 'SENT', 'FAILED'].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }))} />
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="No emails."
        columns={[
          { key: 'createdAt', header: 'Queued', className: 'whitespace-nowrap', render: (e) => fmtDateTime(e.createdAt) },
          { key: 'to', header: 'To' },
          { key: 'subject', header: 'Subject' },
          { key: 'status', header: 'Status', render: (e) => <div><Badge tone={TONE[e.status]}>{e.status.toLowerCase()}</Badge>{e.lastError && <div className="text-xs text-red-600">{e.lastError}</div>}</div> },
          { key: 'attempts', header: 'Attempts', render: (e) => e.attempts },
          { key: 'actions', header: '', render: (e) => e.status === 'FAILED' && <button className="btn btn-sm" onClick={async () => { try { await api(`/api/admin/emails/${e.id}/retry`, { method: 'POST' }); toast('Queued for retry'); reload(); } catch (x) { toast((x as Error).message, 'err'); } }}>Retry</button> },
        ]} />
    </div>
  );
}
export default function EmailsPage() { return <Suspense><Inner /></Suspense>; }
