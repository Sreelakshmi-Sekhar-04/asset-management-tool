'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, useApi } from '@/components/api';
import { assetFiltersFromQuery } from '@/components/asset-filters';
import { PrintLabelsDialog } from '@/components/labels';
import { AssetStatus, Flags } from '@/components/badges';
import { BulkAssignDialog, bulkAssignMessage } from '@/components/bulk-assign';
import { Dash, DuplicateDetails, HolderCell, LocationCell, TransferStatusCell, useAssetColumnFilters, WarrantyCell, type DuplicateInfo, type TransferInfo } from '@/components/asset-list-parts';
import { ActiveFilters } from '@/components/column-filter';
import { DataTable, emptySelection, SavedFiltersMenu, selectionCount, useListState, type Column, type Selection } from '@/components/list';
import { useMe } from '@/components/me';
import { Badge, ErrorBox, Field, FormModal, PageHeader, useToast } from '@/components/ui';

export interface AssetRow {
  id: string; assetCode: string; legacyTag: string | null; category: string; make: string; model: string; serialNumber: string | null; hostname: string | null; ipAddress: string | null;
  status: string; location: string | null; holderType: string | null; holder: string | null; warrantyEnd: string | null; flags: string[]; openTransfer: { id: string; transferNo: string; status: string; toLocation: string } | null;
  transferStatus: string; transfer: TransferInfo | null; duplicates: DuplicateInfo[];
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
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const total = data?.total ?? 0;
  const count = selectionCount(sel, total);
  const { filters, chips } = useAssetColumnFilters(ls);
  const selPayload = () => (sel.mode === 'ids' ? { assetIds: [...sel.ids] } : { filter: assetFiltersFromQuery(ls.query), excludeIds: [...sel.exclude] });

  // Asset ID, Category, Legacy tag, IP address, Status and Transfer status each have their own
  // column, first, so they are in view; the rest follow and the table scrolls sideways when needed.
  const baseCols: Column<AssetRow>[] = [
    { key: 'assetCode', header: 'Asset ID', sortable: true, className: 'align-middle', render: (r) => <Link href={`/assets/${r.id}`} className="whitespace-nowrap font-semibold">{r.assetCode}</Link> },
    { key: 'name', header: 'Asset name', sortable: true, className: 'align-middle', render: (r) => (
      <span className="block min-w-[8rem]"><span className="text-slate-600">{r.make}</span> <span className="font-medium text-slate-900">{r.model}</span></span>
    ) },
    { key: 'category', header: 'Category', sortable: true, className: 'align-middle', render: (r) => <span className="whitespace-nowrap">{r.category}</span> },
    { key: 'serialNumber', header: 'Serial no.', sortable: true, className: 'align-middle', render: (r) => (r.serialNumber ? <span className="whitespace-nowrap font-mono text-xs text-slate-700">{r.serialNumber}</span> : <Dash />) },
    { key: 'legacyTag', header: 'Legacy tag', sortable: true, className: 'align-middle', render: (r) => (r.legacyTag ? <span className="whitespace-nowrap text-xs">{r.legacyTag}</span> : <Dash />) },
    { key: 'ipAddress', header: 'IP address', sortable: true, className: 'align-middle', render: (r) => (r.ipAddress ? <span className="whitespace-nowrap font-mono text-xs">{r.ipAddress}</span> : <Dash />) },
    { key: 'status', header: 'Status', sortable: true, className: 'align-middle', render: (r) => (
      <span className="flex flex-col items-start gap-1">
        <AssetStatus s={r.status} />
        {r.openTransfer && <Badge tone="purple" title={`To ${r.openTransfer.toLocation}`}>{r.openTransfer.transferNo}</Badge>}
        {r.flags.length > 0 && <Flags flags={r.flags} />}
        <DuplicateDetails items={r.duplicates} compact />
      </span>
    ) },
    { key: 'transferStatus', header: 'Transfer status', sortable: true, className: 'align-middle', render: (r) => <TransferStatusCell status={r.transferStatus} transfer={r.transfer} /> },
    { key: 'location', header: 'Location', sortable: true, className: 'align-middle', render: (r) => <LocationCell path={r.location} /> },
    { key: 'holder', header: 'Assigned to', className: 'align-middle', render: (r) => <HolderCell type={r.holderType} holder={r.holder} /> },
    { key: 'hostname', header: 'Hostname', sortable: true, className: 'align-middle', render: (r) => (r.hostname ? <span className="whitespace-nowrap">{r.hostname}</span> : <Dash />) },
    { key: 'warrantyEnd', header: 'Warranty end', sortable: true, className: 'align-middle', render: (r) => <WarrantyCell end={r.warrantyEnd} /> },
  ];
  const cols = baseCols.map((c) => ({ ...c, filter: filters[c.key] }));

  const labels = () => {
    if (sel.mode !== 'ids') { toast('Labels are generated for explicitly selected assets (up to 2,000).', 'err'); return; }
    setLabelsOpen(true);
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
      <PageHeader title="Asset register" subtitle={me.isBranch ? `Assets at ${me.scopeName}` : me.organization ? `Assets of ${me.organization.name}` : undefined}
        actions={<>
          <Link href="/scan" className="btn">Scan asset</Link>
          {me.isIT && <Link href="/assets/new" className="btn btn-primary">+ Create asset</Link>}
        </>} />
      {count > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {me.isIT && <button className="btn btn-sm btn-primary" onClick={() => setAssignOpen(true)}>{count > 1 ? `Assign ${count}` : 'Assign'}</button>}
          <button className="btn btn-sm" onClick={labels}>Print labels</button>
          {me.isIT && <>
            <button className="btn btn-sm" onClick={() => { setBulk('CHECK_IN'); setReason(''); }}>Check in</button>
            <button className="btn btn-sm" onClick={() => { setBulk('REPAIR'); setReason(''); }}>Send to repair</button>
            <button className="btn btn-sm" onClick={() => { setBulk('REPAIR_DONE'); setReason(''); }}>Repair done</button>
            <button className="btn btn-sm" onClick={() => { setBulk('RETIRE'); setReason(''); }}>Retire</button>
          </>}
        </div>
      )}
      <ErrorBox error={error} className="mb-3" />
      <DataTable columns={cols} rows={data?.rows ?? []} total={total} loading={loading} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onPageSize={(n) => ls.set('pageSize', String(n))} onSort={(k, d) => ls.setMany({ sort: k, dir: d })}
        selection={sel} onSelection={setSel} empty="No assets match these filters."
        toolbar={<ActiveFilters chips={chips} onClearAll={ls.clear} right={<SavedFiltersMenu page="assets" query={ls.query} onApply={(q) => router.replace(`/assets?${q}`)} />} />} />
      <BulkAssignDialog open={assignOpen} onClose={() => setAssignOpen(false)} count={count} selection={selPayload}
        onDone={(r) => { toast(bulkAssignMessage(r)); setSel(emptySelection()); reload(); }} />
      <PrintLabelsDialog open={labelsOpen} onClose={() => setLabelsOpen(false)} assetIds={sel.mode === 'ids' ? [...sel.ids] : []} />
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
