'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fmtDateOnly } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/labels';
import { api, download, useApi } from '@/components/api';
import { assetFiltersFromQuery } from '@/components/asset-filters';
import { AssetStatus, Flags } from '@/components/badges';
import { DataTable, emptySelection, FilterSelect, SavedFilters, SearchBox, selectionCount, useListState, type Column, type Selection } from '@/components/list';
import { useMe } from '@/components/me';
import { CategorySelect, LocationSelect } from '@/components/pickers';
import { Badge, ErrorBox, Field, FormModal, PageHeader, useToast } from '@/components/ui';

export interface AssetRow {
  id: string; assetCode: string; legacyTag: string | null; category: string; make: string; model: string; serialNumber: string | null; hostname: string | null; ipAddress: string | null;
  status: string; location: string | null; holder: string | null; warrantyEnd: string | null; flags: string[]; openTransfer: { id: string; transferNo: string; status: string; toLocation: string } | null;
}

export default function AssetRegister() {
  const me = useMe();
  const router = useRouter();
  const toast = useToast();
  const ls = useListState({ sort: 'assetCode', dir: 'desc' });
  const { data, loading, error, reload } = useApi<{ rows: AssetRow[]; total: number }>(`/api/assets?${ls.apiQuery}`);
  const [sel, setSel] = useState<Selection>(emptySelection());
  const [bulk, setBulk] = useState<'' | 'REPAIR' | 'REPAIR_DONE' | 'RETIRE' | 'CHECK_IN'>('');
  const [reason, setReason] = useState('');
  const [disposal, setDisposal] = useState('SCRAPPED');
  const [busyExport, setBusyExport] = useState(false);
  const total = data?.total ?? 0;
  const count = selectionCount(sel, total);
  const selPayload = () => (sel.mode === 'ids' ? { assetIds: [...sel.ids] } : { filter: assetFiltersFromQuery(ls.query), excludeIds: [...sel.exclude] });

  const cols: Column<AssetRow>[] = [
    { key: 'assetCode', header: 'Asset ID', sortable: true, render: (r) => <Link href={`/assets/${r.id}`} className="font-medium">{r.assetCode}</Link> },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'make', header: 'Make / model', sortable: true, render: (r) => <span>{r.make} {r.model}{r.legacyTag && <span className="block text-xs text-slate-500">Legacy {r.legacyTag}</span>}</span> },
    { key: 'serialNumber', header: 'Serial', sortable: true, render: (r) => r.serialNumber ?? '—' },
    { key: 'hostname', header: 'Hostname / IP', sortable: true, render: (r) => <span>{r.hostname ?? '—'}{r.ipAddress && <span className="block text-xs text-slate-500">{r.ipAddress}</span>}</span> },
    { key: 'location', header: 'Location', sortable: true, render: (r) => <span className="text-xs">{r.location ?? '—'}</span> },
    { key: 'holder', header: 'Holder', render: (r) => r.holder ?? '—' },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <span className="flex flex-col gap-1"><AssetStatus s={r.status} />{r.openTransfer && <Link href={`/transfers/${r.openTransfer.id}`}><Badge tone="purple" title={`To ${r.openTransfer.toLocation}`}>{r.openTransfer.transferNo}</Badge></Link>}</span> },
    { key: 'warrantyEnd', header: 'Warranty end', sortable: true, render: (r) => fmtDateOnly(r.warrantyEnd) },
    { key: 'flags', header: 'Flags', render: (r) => <Flags flags={r.flags} /> },
  ];

  const exportView = async (format: 'csv' | 'xlsx') => {
    setBusyExport(true);
    try { await download(`/api/reports/asset-register?${ls.query}${ls.query ? '&' : ''}format=${format}`); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusyExport(false); }
  };
  const toTransfer = () => {
    sessionStorage.setItem('transfer-selection', JSON.stringify({ ...selPayload(), count }));
    router.push('/transfers/new?from=selection');
  };
  const labels = async () => {
    if (sel.mode !== 'ids') { toast('Labels are generated for explicitly selected assets (up to 2,000).', 'err'); return; }
    try { await download('/api/assets/labels', { assetIds: [...sel.ids] }); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const runBulk = async () => {
    if (bulk === 'CHECK_IN') {
      if (sel.mode !== 'ids') throw new Error('Select assets explicitly for bulk check-in.');
      return api('/api/assets/bulk-check-in', { body: { assetIds: [...sel.ids], remarks: reason || undefined } });
    }
    const r = await api<{ pendingApproval?: { requestNo: string }; count?: number }>('/api/assets/bulk-status', { body: { op: bulk, ...selPayload(), reason: reason || undefined, disposalType: bulk === 'RETIRE' ? disposal : undefined } });
    toast(r.pendingApproval ? `Sent for approval as ${r.pendingApproval.requestNo}` : 'Done');
  };

  return (
    <div>
      <PageHeader title="Asset register" subtitle={me.isBranch ? `Assets at ${me.scopeName}` : undefined}
        actions={<>
          {me.isIT && <Link href="/assets/new" className="btn btn-primary">Register asset</Link>}
          <button className="btn" disabled={busyExport} onClick={() => exportView('csv')}>Export CSV</button>
          <button className="btn" disabled={busyExport} onClick={() => exportView('xlsx')}>Export Excel</button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={ls.get('search')} onChange={(v) => ls.set('search', v)} placeholder="Asset ID, serial, hostname, IP, make, model, holder…" />
        <CategorySelect value={ls.get('categoryId')} onChange={(v) => ls.set('categoryId', v)} className="w-auto" placeholder="Category: all" />
        <FilterSelect label="Status" value={ls.getAll('status').length === 1 ? ls.get('status') : ''} onChange={(v) => ls.set('status', v)} options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
        <LocationSelect value={ls.get('locationId')} onChange={(v) => ls.set('locationId', v)} className="w-auto max-w-[14rem]" placeholder="Location: all" />
        <FilterSelect label="Holder" value={ls.get('holderType')} onChange={(v) => ls.set('holderType', v)} options={[{ value: 'EMPLOYEE', label: 'Employee' }, { value: 'DEPARTMENT', label: 'Department' }, { value: 'LOCATION', label: 'Location' }, { value: 'NONE', label: 'No holder' }]} />
        <FilterSelect label="Flag" value={ls.get('flag')} onChange={(v) => ls.set('flag', v)} options={[{ value: 'ANY', label: 'Any flag' }, { value: 'TRANSFER_EXCEPTION', label: 'Transfer exception' }, { value: 'MISSING', label: 'Missing' }, { value: 'DUPLICATE_SUSPECT', label: 'Duplicate-suspect' }]} />
        <FilterSelect label="Warranty" value={ls.get('warrantyWithinDays') || (ls.get('warrantyExpired') ? 'expired' : '')} onChange={(v) => ls.setMany({ warrantyWithinDays: v === 'expired' ? null : v, warrantyExpired: v === 'expired' ? 'true' : null })} options={[{ value: '30', label: 'Ends ≤ 30 days' }, { value: '60', label: 'Ends ≤ 60 days' }, { value: '90', label: 'Ends ≤ 90 days' }, { value: 'expired', label: 'Expired' }]} />
        {ls.query && <button className="btn btn-ghost btn-sm" onClick={ls.clear}>Clear filters</button>}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SavedFilters page="assets" query={ls.query} onApply={(q) => router.replace(`/assets?${q}`)} />
        {count > 0 && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm btn-primary" onClick={toTransfer}>Transfer {count}</button>
            <button className="btn btn-sm" onClick={labels}>Print labels</button>
            {me.isIT && <>
              <button className="btn btn-sm" onClick={() => { setBulk('CHECK_IN'); setReason(''); }}>Check in</button>
              <button className="btn btn-sm" onClick={() => { setBulk('REPAIR'); setReason(''); }}>Send to repair</button>
              <button className="btn btn-sm" onClick={() => { setBulk('REPAIR_DONE'); setReason(''); }}>Repair done</button>
              <button className="btn btn-sm" onClick={() => { setBulk('RETIRE'); setReason(''); }}>Retire</button>
            </>}
          </div>
        )}
      </div>
      <ErrorBox error={error} className="mb-3" />
      <DataTable columns={cols} rows={data?.rows ?? []} total={total} loading={loading} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} onSort={(k, d) => ls.setMany({ sort: k, dir: d })}
        selection={sel} onSelection={setSel} empty="No assets match these filters." />
      <FormModal open={!!bulk} onClose={() => setBulk('')} danger={bulk === 'RETIRE'}
        title={{ REPAIR: 'Send to repair', REPAIR_DONE: 'Complete repair', RETIRE: 'Retire assets', CHECK_IN: 'Check in', '': '' }[bulk]}
        submitLabel={`Apply to ${count}`}
        onSubmit={async () => { await runBulk(); setSel(emptySelection()); reload(); }}>
        <p className="text-sm text-slate-600">This applies to all {count} selected asset(s) together. If any one fails validation nothing is changed and every failing asset is listed.</p>
        {bulk === 'RETIRE' && (
          <Field label="Disposal type" required>
            <select className="input" value={disposal} onChange={(e) => setDisposal(e.target.value)}>
              <option value="SCRAPPED">Scrapped</option><option value="SOLD">Sold</option><option value="DONATED">Donated</option><option value="LOST">Lost</option>
            </select>
          </Field>
        )}
        <Field label={bulk === 'REPAIR' || bulk === 'RETIRE' ? 'Reason' : 'Remarks'} required={bulk === 'REPAIR' || bulk === 'RETIRE'}>
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required={bulk === 'REPAIR' || bulk === 'RETIRE'} />
        </Field>
      </FormModal>
    </div>
  );
}
