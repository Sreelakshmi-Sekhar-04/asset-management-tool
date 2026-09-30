'use client';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDateOnly, todayIST } from '@/lib/format';
import { api, useApi } from '@/components/api';
import { TaskStatus } from '@/components/badges';
import { DataTable, FilterSelect, useListState } from '@/components/list';
import { useMe } from '@/components/me';
import { useLocations } from '@/components/pickers';
import { Badge, Card, Field, FormModal, PageHeader, useToast } from '@/components/ui';

interface Camp { id: string; name: string; dueDate: string; scope: string; status: string; recurrenceQuarterly: boolean; nextRunAt: string | null; tasks: number; notStarted: number; inProgress: number; submitted: number; signedOff: number; overdue: number }
interface TaskRow { id: string; status: string; overdue: boolean; location: { namePath: string }; campaign: { id: string; name: string; dueDate: string }; stats: { total: number; present: number; missing: number; wrong: number; unmarked: number; unlisted: number; pendingReview: number; inTransit: number }; submittedAt: string | null; signedOffAt: string | null }

export default function Verification() {
  const me = useMe();
  const toast = useToast();
  const { data: camps, reload } = useApi<Camp[]>('/api/verification/campaigns');
  const ls = useListState();
  const { data: tasks, loading } = useApi<{ rows: TaskRow[]; total: number }>(`/api/verification/tasks?${ls.apiQuery}`);
  const { data: locs } = useLocations();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', dueDate: '', scope: 'ALL', scopeLocationIds: [] as string[], recurrenceQuarterly: false });
  const scopeOptions = (locs ?? []).filter((l) => (f.scope === 'REGIONS' ? l.type !== 'BRANCH' : l.type === 'BRANCH'));
  return (
    <div className="space-y-4">
      <PageHeader title="Physical verification" actions={<>
        <Link href="/verification/discrepancies" className="btn">Discrepancies</Link>
        {me.isIT && <button className="btn btn-primary" onClick={() => setOpen(true)}>New campaign</button>}
      </>} />
      <Card title="Campaigns">
        {!camps?.length ? <p className="text-sm text-slate-500">No campaigns yet.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Campaign</th><th>Due</th><th>Status</th><th>Branches</th><th>Not started</th><th>In progress</th><th>Submitted</th><th>Signed off</th><th>Overdue</th></tr></thead>
            <tbody>{camps.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/verification/campaigns/${c.id}`} className="font-medium">{c.name}</Link>{c.recurrenceQuarterly && <span className="ml-1 text-xs text-slate-500">↻ quarterly{c.nextRunAt ? `, next ${fmtDateOnly(c.nextRunAt)}` : ''}</span>}</td>
                <td>{fmtDateOnly(c.dueDate)}</td><td><Badge tone={c.status === 'ACTIVE' ? 'blue' : 'gray'}>{c.status.toLowerCase()}</Badge></td>
                <td>{c.tasks}</td><td>{c.notStarted}</td><td>{c.inProgress}</td><td>{c.submitted}</td><td>{c.signedOff}</td><td className={c.overdue ? 'font-medium text-red-600' : ''}>{c.overdue}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2"><h2>{me.isBranch ? 'My verification tasks' : 'Branch tasks'}</h2>
          <FilterSelect label="Status" value={ls.get('status')} onChange={(v) => ls.set('status', v)} options={['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'SIGNED_OFF'].map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() }))} /></div>
        <DataTable rows={tasks?.rows ?? []} total={tasks?.total ?? 0} loading={loading} page={ls.page} pageSize={ls.pageSize} onPage={(p) => ls.setMany({ page: String(p) }, false)}
          columns={[
            { key: 'branch', header: 'Branch', render: (r) => <Link href={`/verification/tasks/${r.id}`} className="font-medium">{r.location.namePath}</Link> },
            { key: 'campaign', header: 'Campaign', render: (r) => <span className="text-xs">{r.campaign.name}<br />Due {fmtDateOnly(r.campaign.dueDate)}</span> },
            { key: 'status', header: 'Status', render: (r) => <span className="flex flex-col items-start gap-1"><TaskStatus s={r.status} />{r.overdue && <Badge tone="red">Overdue</Badge>}</span> },
            { key: 'progress', header: 'Progress', render: (r) => <span className="text-xs">{r.stats.total - r.stats.unmarked} of {r.stats.total} marked{r.stats.inTransit ? ` · ${r.stats.inTransit} in transit (excluded)` : ''}</span> },
            { key: 'disc', header: 'Discrepancies', render: (r) => <span className="text-xs">{r.stats.missing} missing · {r.stats.wrong} wrong · {r.stats.unlisted} unlisted{r.stats.pendingReview ? <b className="block text-amber-700">{r.stats.pendingReview} awaiting IT review</b> : null}</span> },
          ]} />
      </div>
      <FormModal open={open} onClose={() => setOpen(false)} title="New verification campaign" submitLabel="Create campaign"
        onSubmit={async () => { const r = await api<{ tasks: number; lines: number }>('/api/verification/campaigns', { body: f }); toast(`Created ${r.tasks} branch task(s) with ${r.lines} assets`); reload(); }}>
        <Field label="Name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Due date" required><input className="input" type="date" min={todayIST()} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} required /></Field>
        <Field label="Scope"><select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, scopeLocationIds: [] })}><option value="ALL">All branches</option><option value="REGIONS">Selected regions / states</option><option value="BRANCHES">Selected branches</option></select></Field>
        {f.scope !== 'ALL' && (
          <div className="max-h-48 overflow-auto rounded border p-2 text-sm">
            {scopeOptions.map((l) => <label key={l.id} className="flex items-center gap-2"><input type="checkbox" checked={f.scopeLocationIds.includes(l.id)} onChange={(e) => setF({ ...f, scopeLocationIds: e.target.checked ? [...f.scopeLocationIds, l.id] : f.scopeLocationIds.filter((x) => x !== l.id) })} />{l.namePath}</label>)}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.recurrenceQuarterly} onChange={(e) => setF({ ...f, recurrenceQuarterly: e.target.checked })} />Repeat every quarter</label>
        <p className="text-xs text-slate-500">Each branch gets a task listing the assets there right now. Assets in an open transfer are listed separately and excluded from the checklist.</p>
      </FormModal>
    </div>
  );
}
