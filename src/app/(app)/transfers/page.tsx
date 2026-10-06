'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { label, TRANSFER_STATUS_LABEL } from '@/lib/labels';
import { fmtDateOnly } from '@/lib/format';
import { useApi } from '@/components/api';
import { ActiveFilters, DateRangeFilter, MultiOptionFilter, OptionFilter, SelectFilter, TextFilter, type ColumnFilterDef, type FilterChip } from '@/components/column-filter';
import { DataTable, SavedFiltersMenu, useListState } from '@/components/list';
import { LocationSelect, useLocations } from '@/components/pickers';
import { transferColumns, type TransferRow } from '@/components/transfer-list';
import { ExceptionsView, InboundView } from '@/components/transfer-views';
import { useMe } from '@/components/me';
import { ErrorBox, PageHeader, Tabs } from '@/components/ui';

const DIRECTION_OPTS = [{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }];
/** Receiving and exceptions are views of the register rather than menu entries of their own. */
const VIEWS = [
  { key: 'all', label: 'All transfers' },
  { key: 'inbound', label: 'To receive' },
  { key: 'exceptions', label: 'Exceptions' },
];

export default function Transfers() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = VIEWS.some((v) => v.key === sp.get('view')) ? sp.get('view')! : 'all';
  return (
    <div>
      <PageHeader title="Transfer register" actions={<Link href="/transfers/new" className="btn btn-primary">New transfer</Link>} />
      {/* Each view has its own filters, so switching starts from a clean URL. */}
      <Tabs tabs={VIEWS} value={view} onChange={(k) => router.replace(k === 'all' ? pathname : `${pathname}?view=${k}`, { scroll: false })} />
      {view === 'inbound' ? <InboundView /> : view === 'exceptions' ? <ExceptionsView /> : <AllTransfers />}
    </div>
  );
}

function AllTransfers() {
  const me = useMe();
  const router = useRouter();
  const ls = useListState({ sort: 'requestedAt', dir: 'desc' });
  const { data, loading, error } = useApi<{ rows: TransferRow[]; total: number }>(`/api/transfers?${ls.apiQuery}`);
  const { data: locs } = useLocations(false, true);
  const locName = (id: string) => locs?.find((l) => l.id === id)?.name ?? '…';
  const statuses = ls.getAll('status');

  const filters: Record<string, ColumnFilterDef> = {
    transferNo: {
      active: !!ls.get('transferNo') || !!ls.get('direction'),
      content: (close) => <>
        <TextFilter value={ls.get('transferNo')} placeholder="Transfer number or Asset ID…" onApply={(v) => ls.set('transferNo', v)} close={close} />
        {me.isBranch && <div className="border-t pt-3"><OptionFilter label="Direction" value={ls.get('direction')} options={DIRECTION_OPTS} allLabel="Both directions" onChange={(v) => ls.set('direction', v)} close={close} /></div>}
      </>,
    },
    route: {
      active: !!ls.get('fromLocationId') || !!ls.get('toLocationId'),
      content: (close) => <>
        <SelectFilter label="From"><LocationSelect all value={ls.get('fromLocationId')} onChange={(v) => { ls.set('fromLocationId', v); close(); }} placeholder="Any location" /></SelectFilter>
        <SelectFilter label="To"><LocationSelect all value={ls.get('toLocationId')} onChange={(v) => { ls.set('toLocationId', v); close(); }} placeholder="Any location" /></SelectFilter>
      </>,
    },
    reason: {
      active: !!ls.get('reason'),
      content: (close) => <TextFilter value={ls.get('reason')} placeholder="Reason contains…" onApply={(v) => ls.set('reason', v)} close={close} />,
    },
    status: {
      active: statuses.length > 0,
      content: (close) => <MultiOptionFilter label="Status" values={statuses} options={Object.entries(TRANSFER_STATUS_LABEL).map(([value, label]) => ({ value, label }))} onApply={(v) => ls.set('status', v)} close={close} />,
    },
    requestedAt: {
      active: !!ls.get('dateFrom') || !!ls.get('dateTo'),
      content: (close) => <DateRangeFilter from={ls.get('dateFrom')} to={ls.get('dateTo')} onApply={(f, t) => ls.setMany({ dateFrom: f, dateTo: t })} close={close} />,
    },
  };

  const chips: FilterChip[] = [];
  if (ls.get('search')) chips.push({ label: `Search: “${ls.get('search')}”`, clear: () => ls.set('search', null) });
  if (ls.get('transferNo')) chips.push({ label: `Transfer: “${ls.get('transferNo')}”`, clear: () => ls.set('transferNo', null) });
  if (ls.get('direction')) chips.push({ label: ls.get('direction') === 'inbound' ? 'Inbound' : 'Outbound', clear: () => ls.set('direction', null) });
  if (ls.get('fromLocationId')) chips.push({ label: `From: ${locName(ls.get('fromLocationId'))}`, clear: () => ls.set('fromLocationId', null) });
  if (ls.get('toLocationId')) chips.push({ label: `To: ${locName(ls.get('toLocationId'))}`, clear: () => ls.set('toLocationId', null) });
  if (ls.get('reason')) chips.push({ label: `Reason: “${ls.get('reason')}”`, clear: () => ls.set('reason', null) });
  if (statuses.length) chips.push({ label: `Status: ${statuses.map((s) => label(TRANSFER_STATUS_LABEL, s)).join(', ')}`, clear: () => ls.set('status', null) });
  if (ls.get('dateFrom') || ls.get('dateTo')) {
    const f = ls.get('dateFrom'), t = ls.get('dateTo');
    chips.push({ label: `Requested: ${f ? fmtDateOnly(f) : '…'} to ${t ? fmtDateOnly(t) : '…'}`, clear: () => ls.setMany({ dateFrom: null, dateTo: null }) });
  }

  const cols = transferColumns().map((c) => ({ ...c, filter: filters[c.key] }));
  return (
    <div>
      <ErrorBox error={error} className="mb-3" />
      <DataTable columns={cols} rows={data?.rows ?? []} total={data?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onSort={(k, d) => ls.setMany({ sort: k, dir: d })} onPageSize={(n) => ls.set('pageSize', String(n))}
        empty={chips.length ? 'No transfers match these filters.' : 'No transfers yet.'}
        toolbar={<ActiveFilters chips={chips} onClearAll={ls.clear} right={<SavedFiltersMenu page="transfers" query={ls.query} onApply={(q) => router.replace(`/transfers?${q}`)} />} />} />
    </div>
  );
}
