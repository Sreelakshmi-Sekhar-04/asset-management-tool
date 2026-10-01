'use client';
import { useApi } from '@/components/api';
import { DataTable, useListState } from '@/components/list';
import { transferColumns, type TransferRow } from '@/components/transfer-list';
import { ErrorBox, PageHeader } from '@/components/ui';

export default function Inbox() {
  const ls = useListState();
  const { data, loading, error } = useApi<{ rows: TransferRow[]; total: number }>(`/api/transfers/inbox?${ls.apiQuery}`);
  const { data: s } = useApi<{ transferAgingDays: number }>('/api/settings/public');
  return (
    <div>
      <PageHeader title="Inbound transfers" subtitle="Transfers on their way to you. Open one to record what arrived." actions={
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ls.get('includeClosed') === 'true'} onChange={(e) => ls.set('includeClosed', e.target.checked ? 'true' : null)} />Include completed</label>} />
      <ErrorBox error={error} className="mb-3" />
      <DataTable columns={transferColumns(s?.transferAgingDays)} rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="Nothing in transit to you." />
    </div>
  );
}
