'use client';
import { useParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { DISPOSAL_LABEL, HOLDER_TYPE_LABEL, MOVEMENT_LABEL, RENEWABLE_TYPE_LABEL, STATUS_LABEL, TRANSFER_STATUS_LABEL, VER_TASK_LABEL } from '@/lib/labels';
import { download, useApi } from '@/components/api';
import { DataTable, FilterSelect, SavedFilters, SearchBox, useListState } from '@/components/list';
import { CategorySelect, LocationSelect } from '@/components/pickers';
import { ErrorBox, PageHeader, useToast } from '@/components/ui';

interface Row { id: string; _cells: string[] }
interface Def { key: string; title: string; description: string; filters: string[] }
interface Res { title: string; columns: { key: string; header: string }[]; rows: { _cells: string[] }[]; total: number; summary: Record<string, unknown> | null; asOf: string }

const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));
const STATUS_BY_REPORT: Record<string, Record<string, string>> = {
  'asset-register': STATUS_LABEL, 'assets-by-holder': STATUS_LABEL, 'transfer-history': TRANSFER_STATUS_LABEL,
  exceptions: { OPEN: 'Open', RESOLVED: 'Resolved' }, 'verification-status': VER_TASK_LABEL, renewables: { ACTIVE: 'Active', EXPIRED: 'Expired', CANCELLED: 'Cancelled' },
};

function Inner() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const toast = useToast();
  const ls = useListState();
  const { data: defs } = useApi<Def[]>('/api/reports');
  const def = defs?.find((d) => d.key === key);
  const { data: camps } = useApi<{ id: string; name: string }[]>(def?.filters.includes('campaignId') ? '/api/verification/campaigns' : null);
  const { data, error, loading } = useApi<Res>(`/api/reports/${key}?${ls.apiQuery}`);
  const exp = (fmt: string) => download(`/api/reports/${key}?${ls.apiQuery}&format=${fmt}`).catch((e) => toast(e.message, 'err'));

  const control = (f: string) => {
    const v = ls.get(f);
    const set = (x: string) => ls.set(f, x);
    switch (f) {
      case 'search': return <SearchBox key={f} value={v} onChange={set} placeholder="Search" />;
      case 'assetCode': return <SearchBox key={f} value={v} onChange={set} placeholder="Asset ID" />;
      case 'categoryId': return <div key={f} className="w-48"><CategorySelect value={v} onChange={set} placeholder="All categories" /></div>;
      case 'locationId': return <div key={f} className="w-56"><LocationSelect value={v} onChange={set} placeholder="All locations" /></div>;
      case 'fromLocationId': return <div key={f} className="w-52"><LocationSelect value={v} onChange={set} placeholder="From: any" all /></div>;
      case 'toLocationId': return <div key={f} className="w-52"><LocationSelect value={v} onChange={set} placeholder="To: any" all /></div>;
      case 'status': return STATUS_BY_REPORT[key] ? <FilterSelect key={f} label="Status" value={v} onChange={set} options={opts(STATUS_BY_REPORT[key])} /> : null;
      case 'holderType': return <FilterSelect key={f} label="Holder type" value={v} onChange={set} options={opts(HOLDER_TYPE_LABEL)} />;
      case 'flag': return <FilterSelect key={f} label="Flag" value={v} onChange={set} options={[{ value: 'ANY', label: 'Any flag' }, { value: 'TRANSFER_EXCEPTION', label: 'Transfer exception' }, { value: 'MISSING', label: 'Missing' }, { value: 'DUPLICATE_SUSPECT', label: 'Duplicate suspect' }]} />;
      case 'disposalType': return <FilterSelect key={f} label="Disposal" value={v} onChange={set} options={opts(DISPOSAL_LABEL)} />;
      case 'kind': return <FilterSelect key={f} label="Kind" value={v} onChange={set} options={opts(MOVEMENT_LABEL)} />;
      case 'key': return <FilterSelect key={f} label="Matched key" value={v} onChange={set} options={[{ value: 'serial', label: 'Serial' }, { value: 'hostname', label: 'Hostname' }, { value: 'ip', label: 'IP address' }, { value: 'legacyTag', label: 'Legacy tag' }]} />;
      case 'type': return key === 'import-history'
        ? <FilterSelect key={f} label="Type" value={v} onChange={set} options={[{ value: 'ASSETS', label: 'Assets' }, { value: 'EMPLOYEES', label: 'Employees' }, { value: 'BRANCH_USERS', label: 'Branch users' }]} />
        : <FilterSelect key={f} label="Type" value={v} onChange={set} options={opts(RENEWABLE_TYPE_LABEL)} />;
      case 'withinDays': return <FilterSelect key={f} label="Within" value={v} onChange={set} options={[{ value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: '1 year' }]} />;
      case 'expired': return <label key={f} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={v === 'true'} onChange={(e) => set(e.target.checked ? 'true' : '')} />Expired only</label>;
      case 'dateFrom': return <label key={f} className="flex items-center gap-1 text-sm">From <input type="date" className="input w-auto" value={v} onChange={(e) => set(e.target.value)} /></label>;
      case 'dateTo': return <label key={f} className="flex items-center gap-1 text-sm">To <input type="date" className="input w-auto" value={v} onChange={(e) => set(e.target.value)} /></label>;
      case 'campaignId': return <FilterSelect key={f} label="Campaign" value={v} onChange={set} options={(camps ?? []).map((c) => ({ value: c.id, label: c.name }))} />;
      case 'review': return <FilterSelect key={f} label="Review" value={v} onChange={set} options={[{ value: 'PENDING', label: 'Pending' }, { value: 'ACCEPTED', label: 'Accepted' }, { value: 'REJECTED', label: 'Rejected' }]} />;
      default: return null;
    }
  };

  const cols = (data?.columns ?? []).map((c, i) => ({ key: c.key, header: c.header, className: 'whitespace-nowrap', render: (r: Row) => r._cells[i] }));
  const rows: Row[] = (data?.rows ?? []).map((r, i) => ({ id: String(i), _cells: r._cells }));
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/reports', label: 'Reports' }} title={def?.title ?? data?.title ?? 'Report'} subtitle={def?.description}
        actions={<><button className="btn" onClick={() => exp('xlsx')}>Export Excel</button><button className="btn" onClick={() => exp('csv')}>CSV</button></>} />
      <div className="flex flex-wrap items-center gap-2">
        {def?.filters.map(control)}
        {ls.query && <button className="btn btn-sm btn-ghost" onClick={ls.clear}>Clear filters</button>}
        <SavedFilters page={`report:${key}`} query={ls.query} onApply={(q) => router.replace(`/reports/${key}${q ? `?${q}` : ''}`)} />
      </div>
      {data?.summary && <div className="text-xs text-slate-600">{Object.entries(data.summary).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(v)}`).join(' · ')}</div>}
      <ErrorBox error={error} />
      <DataTable loading={loading} columns={cols} rows={rows} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} />
    </div>
  );
}

export default function ReportPage() {
  return <Suspense><Inner /></Suspense>;
}
