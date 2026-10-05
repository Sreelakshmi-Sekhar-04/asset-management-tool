'use client';
import Link from 'next/link';
import { qs, useApi } from '@/components/api';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { Badge, Card, ErrorBox, PageHeader } from '@/components/ui';

interface Row { id: string; assetId: string; assetCode: string; result: string; snapshot: { make?: string; model?: string; serialNumber?: string | null }; correctedHostname: string | null; correctedIp: string | null; correctedRemarks: string | null; note: string | null; reviewStatus: string | null; reviewNote: string | null; task: { id: string; status: string; location: { namePath: string }; campaign: { name: string } } }
interface Unl { id: string; make: string; model: string; serialNumber: string | null; reviewStatus: string; createdAssetId: string | null; task: { id: string; location: { namePath: string }; campaign: { name: string } } }
interface Camp { id: string; name: string }

const reviewBadge = (s: string | null) => !s || s === 'PENDING' ? <Badge tone="amber">Pending</Badge> : s === 'ACCEPTED' ? <Badge tone="green">Accepted</Badge> : <Badge>Rejected</Badge>;

/** FR-VER-05: consolidated discrepancy view across branches in scope. */
export default function DiscrepanciesPage() {
  const ls = useListState({ review: 'PENDING' });
  const { data: camps } = useApi<Camp[]>('/api/verification/campaigns');
  const { data, error, loading } = useApi<{ rows: Row[]; total: number; unlisted: Unl[] }>(`/api/verification/discrepancies${qs({ campaignId: ls.get('campaignId'), review: ls.get('review') === 'ALL' ? undefined : ls.get('review'), page: ls.page, pageSize: ls.pageSize })}`);
  return (
    <div className="space-y-4">
      <PageHeader back={{ href: '/verification', label: 'Verification' }} title="Verification discrepancies" subtitle="Missing and wrong-details findings, and unlisted assets, across your branches" />
      <div className="flex flex-wrap gap-2">
        <FilterSelect label="Campaign" value={ls.get('campaignId')} onChange={(v) => ls.set('campaignId', v)} options={(camps ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <select className="input w-auto" aria-label="Review status" value={ls.get('review')} onChange={(e) => ls.set('review', e.target.value)}>
          <option value="PENDING">Awaiting review</option><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option><option value="ALL">All</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)}
        empty="No discrepancies match."
        columns={[
          { key: 'branch', header: 'Branch', render: (r) => <Link href={`/verification/tasks/${r.task.id}`}>{r.task.location.namePath}</Link> },
          { key: 'campaign', header: 'Campaign', render: (r) => r.task.campaign.name },
          { key: 'assetCode', header: 'Asset ID', className: 'whitespace-nowrap', render: (r) => <Link href={`/assets/${r.assetId}`}>{r.assetCode}</Link> },
          { key: 'item', header: 'Item', render: (r) => `${r.snapshot.make ?? ''} ${r.snapshot.model ?? ''}` },
          { key: 'result', header: 'Finding', render: (r) => r.result === 'MISSING' ? <Badge tone="red">Missing</Badge> : <Badge tone="amber">Wrong details</Badge> },
          { key: 'detail', header: 'Details', render: (r) => <span className="text-xs">{[r.correctedHostname && `Hostname → ${r.correctedHostname}`, r.correctedIp && `IP → ${r.correctedIp}`, r.correctedRemarks, r.note].filter(Boolean).join(' · ')}</span> },
          { key: 'review', header: 'Review', render: (r) => <div>{reviewBadge(r.reviewStatus)}{r.reviewNote && <div className="text-xs text-slate-500">{r.reviewNote}</div>}</div> },
        ]} />
      <Card title={`Unlisted assets (${data?.unlisted.length ?? 0})`}>
        {!data?.unlisted.length ? <div className="p-4 text-sm text-slate-500">None match.</div> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Branch</th><th>Campaign</th><th>Make / model</th><th>Serial</th><th>Review</th></tr></thead>
            <tbody>{data.unlisted.map((u) => (
              <tr key={u.id}><td><Link href={`/verification/tasks/${u.task.id}?tab=unlisted`}>{u.task.location.namePath}</Link></td><td>{u.task.campaign.name}</td><td>{u.make} {u.model}</td><td>{u.serialNumber ?? '—'}</td>
                <td>{reviewBadge(u.reviewStatus)}{u.createdAssetId && <> · <Link href={`/assets/${u.createdAssetId}`}>asset</Link></>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
