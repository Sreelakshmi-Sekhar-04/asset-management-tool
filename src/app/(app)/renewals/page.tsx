'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import { fmtDateOnly, fmtINR } from '@/lib/format';
import { label, RENEWABLE_TYPE_LABEL } from '@/lib/labels';
import { download, useApi } from '@/components/api';
import { DaysBadge } from '@/components/badges';
import { DataTable, SavedFiltersMenu, useListState, type Column } from '@/components/list';
import { useColumnFilters } from '@/components/list-filters';
import { OptionFilter } from '@/components/column-filter';
import { useMe } from '@/components/me';
import { RenewableFormModal } from '@/components/renewable-form';
import { Badge, ErrorBox, PageHeader, useToast } from '@/components/ui';

interface Row { id: string; type: string; label: string; vendor: string | null; identifier: string | null; expiryDate: string; daysRemaining: number; status: string; critical: boolean; cost: string | null; owner: string | null; reminderState: string; source: string; asset: { id: string; assetCode: string; make: string; model: string; location: { namePath: string } | null } }

function RenewalsInner() {
  const me = useMe();
  const toast = useToast();
  const router = useRouter();
  const sp = useSearchParams();
  const newFor = sp.get('new');
  const defaults = useMemo(() => ({ sort: 'expiryDate', dir: 'asc' }), []);
  const ls = useListState(defaults);
  const { data: asset } = useApi<{ assetCode: string }>(newFor ? `/api/assets/${newFor}` : null);
  const { data, error, loading, reload } = useApi<{ rows: Row[]; total: number }>(`/api/renewables?${ls.apiQuery}`);
  const f = useColumnFilters(ls);
  const due = ls.get('withinDays') ? `w${ls.get('withinDays')}` : ls.get('expired') ? 'expired' : '';
  const DUE_OPTS = [{ value: 'w30', label: 'Within 30 days' }, { value: 'w60', label: 'Within 60 days' }, { value: 'w90', label: 'Within 90 days' }, { value: 'expired', label: 'Expired' }];
  const STATUS_OPTS = [{ value: 'ACTIVE', label: 'Active' }, { value: 'EXPIRED', label: 'Expired' }, { value: 'CANCELLED', label: 'Cancelled' }];
  const columns: Column<Row>[] = [
    { key: 'label', header: 'Name', filter: f.both(f.text('name', 'Name', 'Name, vendor or key contains…'), f.multi('type', 'Type', Object.entries(RENEWABLE_TYPE_LABEL).map(([value, l]) => ({ value, label: l })))),
      render: (r) => <div><Link href={`/renewals/${r.id}`}>{r.label}</Link>{r.critical && <Badge tone="red"> Critical</Badge>}<div className="text-xs text-slate-500">{label(RENEWABLE_TYPE_LABEL, r.type)}{r.vendor ? ` · ${r.vendor}` : ''}</div></div> },
    { key: 'asset', header: 'Asset', filter: f.text('asset', 'Asset', 'Asset ID, make or model contains…'), render: (r) => <div><Link href={`/assets/${r.asset.id}`} className="whitespace-nowrap">{r.asset.assetCode}</Link><div className="text-xs text-slate-500">{r.asset.make} {r.asset.model}</div></div> },
    { key: 'location', header: 'Location', filter: me.isIT ? f.location('locationId') : undefined, render: (r) => <span className="text-xs">{r.asset.location?.namePath ?? '—'}</span> },
    { key: 'expiryDate', header: 'Expiry', sortable: true, className: 'whitespace-nowrap', filter: f.both(
      { active: !!due, content: (close) => <OptionFilter label="Due" value={due} options={DUE_OPTS} allLabel="Any date" onChange={(v) => ls.setMany({ withinDays: v && v !== 'expired' ? v.slice(1) : null, expired: v === 'expired' ? 'true' : null })} close={close} /> },
      f.multi('status', 'Status', STATUS_OPTS)),
      render: (r) => <div>{fmtDateOnly(r.expiryDate)}<div>{r.status === 'CANCELLED' ? <Badge>Cancelled</Badge> : <DaysBadge days={r.daysRemaining} />}</div></div> },
    { key: 'owner', header: 'Owner', filter: f.text('owner', 'Owner'), render: (r) => r.owner ?? '—' },
    { key: 'cost', header: 'Cost', className: 'text-right', render: (r) => (r.cost ? fmtINR(Number(r.cost)) : '—') },
    { key: 'reminders', header: 'Reminders', render: (r) => <span className="text-xs">{r.reminderState}</span> },
  ];
  f.track('withinDays', 'expired');
  if (due) f.chips.push({ label: `Due: ${DUE_OPTS.find((o) => o.value === due)?.label}`, clear: () => ls.setMany({ withinDays: null, expired: null }) });
  if (ls.get('search')) f.chips.push({ label: `Search: “${ls.get('search')}”`, clear: () => ls.set('search', null) });
  const exportQ = (fmt: string) => `/api/reports/renewables?${ls.apiQuery}&format=${fmt}`;
  return (
    <div className="space-y-4">
      <PageHeader title="Renewals" subtitle="Warranties, licences, subscriptions, AMCs and other expiring items tied to assets"
        actions={<>
          <button className="btn" onClick={() => download(exportQ('xlsx')).catch((e) => toast(e.message, 'err'))}>Export Excel</button>
          <button className="btn" onClick={() => download(exportQ('csv')).catch((e) => toast(e.message, 'err'))}>CSV</button>
          {me.isIT && <button className="btn btn-primary" onClick={() => router.replace('/renewals?new=')}>Add renewable</button>}
        </>} />
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} onSort={(sort, dir) => ls.setMany({ sort, dir })}
        empty="No renewables match."
        columns={columns}
        toolbar={f.strip(<SavedFiltersMenu page="renewals" query={ls.query} onApply={(q) => router.replace(`/renewals${q ? `?${q}` : ''}`)} />)} />
      <RenewableFormModal open={newFor !== null} assetCode={asset?.assetCode} onClose={() => router.replace('/renewals')}
        onSaved={(r) => { toast('Renewable added'); reload(); router.push(`/renewals/${r.id}`); }} />
    </div>
  );
}

export default function RenewalsPage() {
  return <Suspense><RenewalsInner /></Suspense>;
}
