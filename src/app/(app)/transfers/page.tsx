'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TRANSFER_STATUS_LABEL } from '@/lib/labels';
import { download, useApi } from '@/components/api';
import { DataTable, FilterSelect, SavedFilters, SearchBox, useListState } from '@/components/list';
import { LocationSelect } from '@/components/pickers';
import { transferColumns, type TransferRow } from '@/components/transfer-list';
import { useMe } from '@/components/me';
import { ErrorBox, PageHeader, useToast } from '@/components/ui';

export default function Transfers() {
  const me = useMe();
  const router = useRouter();
  const toast = useToast();
  const ls = useListState({ sort: 'requestedAt', dir: 'desc' });
  const { data, loading, error } = useApi<{ rows: TransferRow[]; total: number }>(`/api/transfers?${ls.apiQuery}`);
  return (
    <div>
      <PageHeader title="Transfer register" actions={<>
        <Link href="/transfers/new" className="btn btn-primary">New transfer</Link>
        <button className="btn" onClick={() => download(`/api/reports/transfer-register?${ls.query}${ls.query ? '&' : ''}format=csv`).catch((e) => toast(e.message, 'err'))}>Export CSV</button>
        <button className="btn" onClick={() => download(`/api/reports/transfer-register?${ls.query}${ls.query ? '&' : ''}format=xlsx`).catch((e) => toast(e.message, 'err'))}>Export Excel</button>
      </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={ls.get('search')} onChange={(v) => ls.set('search', v)} placeholder="Transfer number, reason or Asset ID" />
        <FilterSelect label="Status" value={ls.getAll('status').length === 1 ? ls.get('status') : ''} onChange={(v) => ls.set('status', v)} options={Object.entries(TRANSFER_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
        {me.isBranch && <FilterSelect label="Direction" value={ls.get('direction')} onChange={(v) => ls.set('direction', v)} options={[{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }]} />}
        <LocationSelect all value={ls.get('fromLocationId')} onChange={(v) => ls.set('fromLocationId', v)} className="w-auto max-w-[12rem]" placeholder="From: any" />
        <LocationSelect all value={ls.get('toLocationId')} onChange={(v) => ls.set('toLocationId', v)} className="w-auto max-w-[12rem]" placeholder="To: any" />
        <input type="date" className="input w-auto" value={ls.get('dateFrom')} onChange={(e) => ls.set('dateFrom', e.target.value)} aria-label="Requested from" />
        <input type="date" className="input w-auto" value={ls.get('dateTo')} onChange={(e) => ls.set('dateTo', e.target.value)} aria-label="Requested to" />
        {ls.query && <button className="btn btn-ghost btn-sm" onClick={ls.clear}>Clear</button>}
      </div>
      <div className="mb-3"><SavedFilters page="transfers" query={ls.query} onApply={(q) => router.replace(`/transfers?${q}`)} /></div>
      <ErrorBox error={error} className="mb-3" />
      <DataTable columns={transferColumns()} rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onSort={(k, d) => ls.setMany({ sort: k, dir: d })} onPageSize={(n) => ls.set('pageSize', String(n))} />
    </div>
  );
}
