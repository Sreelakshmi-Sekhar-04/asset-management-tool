'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { fmtDateOnly } from '@/lib/format';
import { api, useApi } from '@/components/api';
import { TaskStatus } from '@/components/badges';
import { useMe } from '@/components/me';
import { Badge, Card, ErrorBox, PageHeader, Spinner, Stat, useConfirm, useToast } from '@/components/ui';

interface D { campaign: { id: string; name: string; dueDate: string; status: string; recurrenceQuarterly: boolean }; buckets: { notStarted: number; inProgress: number; submitted: number; signedOff: number; overdue: number }; tasks: { id: string; status: string; overdue: boolean; location: { namePath: string }; stats: { total: number; present: number; missing: number; wrong: number; unmarked: number; unlisted: number; pendingReview: number }; signedOffByName: string | null }[] }

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const { data: d, error, reload } = useApi<D>(`/api/verification/campaigns/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <div className="flex justify-center py-20"><Spinner /></div>;
  return (
    <div className="space-y-4">
      {node}
      <PageHeader back={{ href: '/verification', label: 'Verification' }} title={d.campaign.name} subtitle={`Due ${fmtDateOnly(d.campaign.dueDate)}${d.campaign.recurrenceQuarterly ? ' · repeats quarterly' : ''}`}
        actions={me.isIT && d.campaign.status === 'ACTIVE' && <button className="btn" onClick={async () => { if (await confirm('Close this campaign? Open tasks stay as they are; recurrence stops.')) { try { await api(`/api/verification/campaigns/${id}/close`, { method: 'POST' }); toast('Campaign closed'); reload(); } catch (e) { toast((e as Error).message, 'err'); } } }}>Close campaign</button>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Not started" value={d.buckets.notStarted} /><Stat label="In progress" value={d.buckets.inProgress} /><Stat label="Submitted" value={d.buckets.submitted} tone={d.buckets.submitted ? 'amber' : undefined} /><Stat label="Signed off" value={d.buckets.signedOff} tone="green" /><Stat label="Overdue" value={d.buckets.overdue} tone={d.buckets.overdue ? 'red' : undefined} />
      </div>
      <Card title="Branches">
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Branch</th><th>Status</th><th>Marked</th><th>Present</th><th>Missing</th><th>Wrong</th><th>Unlisted</th><th>Pending review</th><th>Signed off by</th></tr></thead>
          <tbody>{d.tasks.map((t) => (
            <tr key={t.id}>
              <td><Link href={`/verification/tasks/${t.id}`}>{t.location.namePath}</Link></td>
              <td><span className="flex gap-1"><TaskStatus s={t.status} />{t.overdue && <Badge tone="red">Overdue</Badge>}</span></td>
              <td>{t.stats.total - t.stats.unmarked}/{t.stats.total}</td><td>{t.stats.present}</td><td>{t.stats.missing}</td><td>{t.stats.wrong}</td><td>{t.stats.unlisted}</td><td>{t.stats.pendingReview || ''}</td><td>{t.signedOffByName ?? ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
