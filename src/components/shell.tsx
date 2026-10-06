'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '@/lib/labels';
import { api } from './api';
import { useMe } from './me';

type Item = { href: string; label: string; roles?: ('ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER')[] };
const IT: Item['roles'] = ['ADMIN', 'IT_OPERATOR'];
const AD: Item['roles'] = ['ADMIN'];
const NAV: { group: string; items: Item[] }[] = [
  { group: '', items: [{ href: '/', label: 'Dashboard' }] },
  { group: 'Assets', items: [
    { href: '/assets', label: 'Asset register' },
    { href: '/employees', label: 'Users & Employees' },
  ] },
  { group: 'Work', items: [
    { href: '/approvals', label: 'Approvals' },
    { href: '/campaigns', label: 'Campaigns' },
    { href: '/renewals', label: 'Renewals' },
  ] },
  { group: 'Insight', items: [
    { href: '/reports', label: 'Reports' },
    { href: '/documents', label: 'Documents' },
    { href: '/integrations', label: 'Integrations', roles: IT },
    { href: '/audit', label: 'Audit log', roles: IT },
  ] },
  { group: 'Administration', items: [
    { href: '/admin/locations', label: 'Locations', roles: AD },
    { href: '/admin/master-data', label: 'Categories & departments', roles: AD },
    { href: '/admin/asset-ids', label: 'Asset IDs & labels', roles: AD },
    { href: '/admin/approval-policies', label: 'Approval policies', roles: AD },
    { href: '/admin/reminder-policies', label: 'Reminder policies', roles: AD },
    { href: '/admin/settings', label: 'Settings', roles: AD },
    { href: '/admin/emails', label: 'Email outbox', roles: AD },
  ] },
];
/** Pages without a menu entry of their own, shown under the entry they are reached from. */
const UNDER: [string, string][] = [['/scan', '/assets'], ['/imports', '/assets'], ['/transfers', '/assets']];

export function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { try { setExpanded(new Set(JSON.parse(localStorage.getItem('itam:nav') ?? '[]') as string[])); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    let alive = true;
    const tick = () => api<{ unread: number }>('/api/notifications/count').then((r) => alive && setUnread(r.unread)).catch(() => undefined);
    tick();
    const t = setInterval(tick, 60_000);
    window.addEventListener('itam:notifications', tick);
    return () => { alive = false; clearInterval(t); window.removeEventListener('itam:notifications', tick); };
    // Deliberately not keyed on the path: the unread count is polled and refreshed by event,
    // so navigating between screens must not re-request it.
  }, []);
  const under = (p: string) => UNDER.find(([from]) => p === from || p.startsWith(`${from}/`))?.[1] ?? p;
  const isActive = (href: string) => {
    const p = under(pathname);
    return href === '/' ? p === '/' : p === href || (p.startsWith(`${href}/`) && !NAV.some((g) => g.items.some((i) => i.href !== href && i.href.startsWith(href) && p.startsWith(i.href))));
  };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); window.location.href = '/login'; };
  // Groups start folded so only the main headings show; the user opens them by hand and
  // each browser remembers which ones are open. A folded group holding the current page
  // keeps its heading highlighted.
  const activeGroup = NAV.find((g) => g.items.some((i) => isActive(i.href)))?.group ?? '';
  const toggleGroup = (g: string) => setExpanded((x) => {
    const n = new Set(x);
    if (n.has(g)) n.delete(g); else n.add(g);
    try { localStorage.setItem('itam:nav', JSON.stringify([...n])); } catch { /* storage unavailable */ }
    return n;
  });
  const nav = (
    <nav className="space-y-1 px-3 py-3 text-sm">
      {NAV.map((g) => {
        const items = g.items.filter((i) => !i.roles || i.roles.includes(me.role));
        if (!items.length) return null;
        const shown = !g.group || expanded.has(g.group);
        const here = g.group === activeGroup;
        return (
          <div key={g.group}>
            {g.group && (
              <button type="button" onClick={() => toggleGroup(g.group)} aria-expanded={shown}
                className={clsx('flex w-full items-center justify-between rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider', here && !shown ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:text-slate-600')}>
                {g.group}<span aria-hidden className="text-[10px]">{shown ? '▾' : '▸'}</span>
              </button>
            )}
            {shown && items.map((i) => (
              <Link key={i.href} href={i.href} className={clsx('block rounded-md px-2 py-1 no-underline hover:no-underline', isActive(i.href) ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100')}>{i.label}</Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className={clsx('fixed inset-y-0 left-0 z-40 w-60 overflow-y-auto border-r bg-white transition-transform lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="border-b px-4 py-3">
          <div className="truncate text-sm font-semibold text-slate-900">{me.orgName}</div>
          <div className="text-xs text-slate-500">IT Asset Management</div>
        </div>
        {nav}
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} />}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-white/95 px-3 py-2 backdrop-blur sm:px-4">
        <button className="btn btn-ghost btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">☰</button>
        <OrganizationPicker />
        <div className="ml-auto flex items-center gap-2">
          <Link href="/notifications" className="btn btn-ghost btn-sm relative" aria-label={`Notifications (${unread} unread)`}>
            🔔{unread > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <details className="relative">
            <summary className="btn btn-ghost btn-sm list-none">
              <span className="hidden max-w-[12rem] truncate sm:inline">{me.name}</span><span className="sm:hidden">👤</span>
            </summary>
            <div className="absolute right-0 z-30 mt-1 w-64 rounded-md border bg-white p-3 text-sm shadow-lg">
              <div className="font-medium">{me.name}</div>
              <div className="text-xs text-slate-500">{me.email}</div>
              <div className="mt-1 text-xs text-slate-500">{ROLE_LABEL[me.role]}{me.scopeName ? ` · ${me.scopeName}` : ''}</div>
              <div className="mt-3 flex flex-col gap-1">
                <Link href="/account" className="btn btn-sm">Account & password</Link>
                <button className="btn btn-sm" onClick={logout}>Sign out</button>
              </div>
            </div>
          </details>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-3 py-4 sm:px-6">{children}</main>
    </div>
  );
}

/**
 * Organization (head quarter) selector (§12). Choosing one stores it server-side in a cookie
 * and reloads, so every screen — dashboard, asset register, people, locations — shows that
 * organization's data until it is changed (§15).
 */
function OrganizationPicker() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  if (!me.organization) return null;
  if (!me.canSwitchOrganization || me.organizations.length < 2) {
    return (
      <span className="flex items-center gap-1 text-xs text-slate-500">
        <span className="hidden sm:inline">Organization:</span>
        <span className="font-medium text-slate-700">{me.organization.name}</span>
      </span>
    );
  }
  const change = async (id: string) => {
    if (id === me.organization!.id) return;
    setBusy(true);
    try {
      await api('/api/organizations', { body: { organizationId: id } });
      window.location.reload();
    } catch { setBusy(false); }
  };
  return (
    <label className="flex items-center gap-1 text-xs text-slate-500">
      <span className="hidden sm:inline">Organization</span>
      <select className="input h-8 w-auto max-w-[12rem] py-0 text-sm" value={me.organization.id} disabled={busy} onChange={(e) => change(e.target.value)} aria-label="Organization">
        {me.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}
