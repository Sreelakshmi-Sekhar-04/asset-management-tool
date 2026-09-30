'use client';
import Link from 'next/link';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { useApi } from '@/components/api';
import { TaskStatus } from '@/components/badges';
import { useMe } from '@/components/me';
import { Card, ErrorBox, PageHeader, Spinner, Stat } from '@/components/ui';

interface Dash {
  scope: string;
  assets: { total: number; assigned: number; inStock: number; underRepair: number; retired: number };
  byCategory: { categoryId: string; name: string; count: number }[];
  byLocation: { id: string; name: string; total: number; assigned: number; inStock: number; underRepair: number }[];
  byLocationLabel: string;
  flags: { transferException: number; missing: number; duplicateSuspect: number };
  transfers: { open: number; inTransit: number; aging: number; agingDays: number };
  exceptionsOpen: number;
  approvals: { total: number; mine: boolean };
  expiring: { d30: number; d60: number; d90: number; expired: number; warranty90: number };
  verification: { id: string; name: string; dueDate: string; tasks: number; notStarted: number; inProgress: number; submitted: number; signedOff: number; overdue: number }[];
  recent: { at: string; actor: string | null; text: string; link: string | null }[];
}

export default function Dashboard() {
  const me = useMe();
  const { data: d, error, loading } = useApi<Dash>('/api/dashboard');
  if (error) return <ErrorBox error={error} />;
  if (loading || !d) return <div className="flex justify-center py-20"><Spinner /></div>;
  const max = Math.max(1, ...d.byLocation.map((l) => l.total));
  return (
    <div className="space-y-4">
      <PageHeader title="Dashboard" subtitle={`Figures for ${d.scope}`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Active assets" value={d.assets.total} href="/assets?status=IN_STOCK&status=ASSIGNED&status=UNDER_REPAIR" />
        <Stat label="Assigned" value={d.assets.assigned} href="/assets?status=ASSIGNED" />
        <Stat label="In stock" value={d.assets.inStock} href="/assets?status=IN_STOCK" />
        <Stat label="Under repair" value={d.assets.underRepair} href="/assets?status=UNDER_REPAIR" tone={d.assets.underRepair ? 'amber' : undefined} />
        <Stat label="Retired" value={d.assets.retired} href="/reports/retired" />
        <Stat label={d.approvals.mine ? 'My pending requests' : 'Awaiting my approval'} value={d.approvals.total} href="/approvals" tone={d.approvals.total ? 'amber' : undefined} />
        <Stat label="Open transfers" value={d.transfers.open} href="/transfers?status=PENDING_APPROVAL&status=IN_TRANSIT&status=PARTIALLY_RECEIVED" />
        <Stat label="In transit" value={d.transfers.inTransit} href="/reports/in-transit" hint={d.transfers.aging ? `${d.transfers.aging} past ${d.transfers.agingDays} days` : undefined} tone={d.transfers.aging ? 'red' : undefined} />
        <Stat label="Open exceptions" value={d.exceptionsOpen} href="/transfers/exceptions?status=OPEN" tone={d.exceptionsOpen ? 'red' : undefined} />
        <Stat label="Expiring ≤ 30 days" value={d.expiring.d30} href="/reports/expiry-outlook?withinDays=30" tone={d.expiring.d30 ? 'amber' : undefined} />
        <Stat label="Expiring ≤ 60 days" value={d.expiring.d60} href="/reports/expiry-outlook?withinDays=60" />
        <Stat label="Expiring ≤ 90 days" value={d.expiring.d90} href="/reports/expiry-outlook?withinDays=90" hint={d.expiring.expired ? `${d.expiring.expired} already expired` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={d.byLocationLabel} className="lg:col-span-2">
          {d.byLocation.length === 0 ? <p className="text-sm text-slate-500">No assets yet.</p> : (
            <ul className="space-y-2 text-sm">
              {d.byLocation.map((l) => (
                <li key={l.id}>
                  <div className="flex justify-between gap-2"><Link href={`/assets?locationId=${l.id}&status=IN_STOCK&status=ASSIGNED&status=UNDER_REPAIR`}>{l.name}</Link><span className="text-slate-600">{l.total}</span></div>
                  <div className="mt-1 flex h-2 overflow-hidden rounded bg-slate-100" title={`Assigned ${l.assigned} · In stock ${l.inStock} · Under repair ${l.underRepair}`}>
                    <div className="bg-green-500" style={{ width: `${(l.assigned / max) * 100}%` }} />
                    <div className="bg-blue-400" style={{ width: `${(l.inStock / max) * 100}%` }} />
                    <div className="bg-amber-400" style={{ width: `${(l.underRepair / max) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-3 text-xs text-slate-500"><span>■ <span className="text-green-600">Assigned</span></span><span>■ <span className="text-blue-500">In stock</span></span><span>■ <span className="text-amber-500">Under repair</span></span></div>
        </Card>
        <Card title="By category">
          <ul className="divide-y text-sm">
            {d.byCategory.map((c) => <li key={c.categoryId} className="flex justify-between py-1.5"><Link href={`/assets?categoryId=${c.categoryId}&status=IN_STOCK&status=ASSIGNED&status=UNDER_REPAIR`}>{c.name}</Link><span>{c.count}</span></li>)}
          </ul>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Flags">
          <ul className="space-y-1.5 text-sm">
            <li className="flex justify-between"><Link href="/assets?flag=TRANSFER_EXCEPTION">Transfer exception</Link><span>{d.flags.transferException}</span></li>
            <li className="flex justify-between"><Link href="/assets?flag=MISSING">Missing (verification)</Link><span>{d.flags.missing}</span></li>
            <li className="flex justify-between"><Link href="/reports/duplicates">Duplicate-suspect</Link><span>{d.flags.duplicateSuspect}</span></li>
          </ul>
        </Card>
        <Card title="Verification progress" className="lg:col-span-2" actions={<Link href="/verification" className="text-xs">All campaigns</Link>}>
          {d.verification.length === 0 ? <p className="text-sm text-slate-500">No active campaigns.</p> : d.verification.map((c) => (
            <div key={c.id} className="mb-3 last:mb-0">
              <div className="flex flex-wrap justify-between gap-2 text-sm"><Link href={`/verification/campaigns/${c.id}`} className="font-medium">{c.name}</Link><span className="text-xs text-slate-500">Due {fmtDateOnly(c.dueDate)}</span></div>
              <div className="mt-1 flex h-2 overflow-hidden rounded bg-slate-100">
                <div className="bg-green-500" style={{ width: `${(c.signedOff / Math.max(1, c.tasks)) * 100}%` }} />
                <div className="bg-amber-400" style={{ width: `${(c.submitted / Math.max(1, c.tasks)) * 100}%` }} />
                <div className="bg-blue-400" style={{ width: `${(c.inProgress / Math.max(1, c.tasks)) * 100}%` }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
                <span><TaskStatus s="SIGNED_OFF" /> {c.signedOff}</span><span><TaskStatus s="SUBMITTED" /> {c.submitted}</span><span><TaskStatus s="IN_PROGRESS" /> {c.inProgress}</span><span><TaskStatus s="NOT_STARTED" /> {c.notStarted}</span>
                {c.overdue > 0 && <span className="font-medium text-red-600">{c.overdue} overdue</span>}
              </div>
            </div>
          ))}
        </Card>
      </div>
      <Card title="Recent activity">
        <ul className="divide-y text-sm">
          {d.recent.map((r, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 py-1.5">
              <span>{r.link ? <Link href={r.link}>{r.text}</Link> : r.text}</span>
              <span className="text-xs text-slate-500">{r.actor ?? 'System'} · {fmtDateTime(r.at)}</span>
            </li>
          ))}
          {d.recent.length === 0 && <li className="py-2 text-slate-500">Nothing yet.</li>}
        </ul>
        {me.isIT && <div className="mt-2 text-right"><Link href="/audit" className="text-xs">Open audit log</Link></div>}
      </Card>
    </div>
  );
}
