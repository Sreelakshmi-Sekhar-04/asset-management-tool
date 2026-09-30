'use client';
import Link from 'next/link';
import { Suspense } from 'react';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/components/api';
import { DocumentsPanel } from '@/components/documents';
import { DataTable, FilterSelect, SearchBox, useListState } from '@/components/list';
import { useMe } from '@/components/me';
import { Badge, ErrorBox, PageHeader } from '@/components/ui';

interface Doc { id: string; entityType: string; entityId: string; fileName: string; mimeType: string; sizeBytes: number; description: string | null; uploadedByName: string; createdAt: string; scanStatus: string; deletedAt: string | null }

const ENTITY: Record<string, string> = { ASSET: 'Asset', TRANSFER: 'Transfer', TRANSFER_RECEIPT: 'Transfer receipt', RENEWABLE: 'Renewable', VERIFICATION_TASK: 'Verification', ORGANISATION: 'Organisation' };
const link = (d: Doc) => ({ ASSET: `/assets/${d.entityId}`, TRANSFER: `/transfers/${d.entityId}`, RENEWABLE: `/renewals/${d.entityId}`, VERIFICATION_TASK: `/verification/tasks/${d.entityId}` } as Record<string, string>)[d.entityType];
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Inner() {
  const me = useMe();
  const ls = useListState();
  const { data, error, loading } = useApi<{ rows: Doc[]; total: number }>(`/api/documents?${ls.apiQuery}`);
  return (
    <div className="space-y-4">
      <PageHeader title="Documents" subtitle="Files attached to assets, transfers, renewals and verifications you can see. Upload files from the record they belong to." />
      <div className="flex flex-wrap gap-2">
        <SearchBox value={ls.get('search')} onChange={(v) => ls.set('search', v)} placeholder="File name" />
        <FilterSelect label="Attached to" value={ls.get('entityType')} onChange={(v) => ls.set('entityType', v)} options={Object.entries(ENTITY).map(([value, label]) => ({ value, label }))} />
        {me.isAdmin && <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ls.get('includeDeleted') === 'true'} onChange={(e) => ls.set('includeDeleted', e.target.checked ? 'true' : '')} />Include deleted</label>}
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)} empty="No documents."
        columns={[
          { key: 'fileName', header: 'File', render: (d) => <span><a href={`/api/documents/${d.id}/download`} className={d.deletedAt ? 'line-through' : ''}>{d.fileName}</a>{(d.scanStatus === 'INFECTED' || d.scanStatus === 'ERROR') && <Badge tone="red"> scan {d.scanStatus.toLowerCase()}</Badge>}{d.description && <div className="text-xs text-slate-500">{d.description}</div>}</span> },
          { key: 'entity', header: 'Attached to', render: (d) => link(d) ? <Link href={link(d)!}>{ENTITY[d.entityType]}</Link> : ENTITY[d.entityType] },
          { key: 'size', header: 'Size', render: (d) => kb(d.sizeBytes) },
          { key: 'uploadedByName', header: 'Uploaded by' },
          { key: 'createdAt', header: 'Uploaded', className: 'whitespace-nowrap', render: (d) => fmtDateTime(d.createdAt) },
        ]} />
      <DocumentsPanel entityType="ORGANISATION" entityId="organisation" canUpload={me.isAdmin} isAdmin={me.isAdmin} title="Organisation documents (policies, contracts)" />
    </div>
  );
}
export default function DocumentsPage() { return <Suspense><Inner /></Suspense>; }
