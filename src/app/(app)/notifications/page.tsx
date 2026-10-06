'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from '@/components/api';
import { DataTable, useListState } from '@/components/list';
import { ErrorBox, PageHeader, useToast } from '@/components/ui';

interface N { id: string; type: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }

function Inner() {
  const toast = useToast();
  const ls = useListState();
  const { data, error, loading, reload } = useApi<{ rows: N[]; total: number; unread: number }>(`/api/notifications${qs({ unread: ls.get('unread') || undefined, page: ls.page, pageSize: ls.pageSize })}`);
  const read = async (ids: string[] | 'all') => { try { await api('/api/notifications/read', { body: { ids } }); reload(); window.dispatchEvent(new Event('itam:notifications')); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" subtitle={data ? `${data.unread} unread` : undefined} actions={data?.unread ? <button className="btn" onClick={() => read('all')}>Mark all read</button> : null} />
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ls.get('unread') === 'true'} onChange={(e) => ls.set('unread', e.target.checked ? 'true' : '')} />Unread only</label>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} empty="No notifications."
        columns={[
          { key: 'title', header: 'Notification', render: (n) => (
            <div className={n.readAt ? 'text-slate-500' : ''}>
              <div className={n.readAt ? '' : 'font-medium'}>{n.link ? <Link href={n.link} onClick={() => !n.readAt && read([n.id])}>{n.title}</Link> : n.title}</div>
              <div className="text-xs">{n.body}</div>
            </div>
          ) },
          { key: 'createdAt', header: 'When', className: 'whitespace-nowrap', render: (n) => fmtDateTime(n.createdAt) },
          { key: 'read', header: '', render: (n) => !n.readAt && <button className="btn btn-sm btn-ghost" onClick={() => read([n.id])}>Mark read</button> },
        ]} />
    </div>
  );
}
export default function NotificationsPage() { return <Suspense><Inner /></Suspense>; }
