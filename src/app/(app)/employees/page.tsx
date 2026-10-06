'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/labels';
import { useApi } from '@/components/api';
import { Dash, LocationCell } from '@/components/asset-list-parts';
import { ActiveFilters, OptionFilter, SelectFilter, TextFilter, type ColumnFilterDef, type FilterChip } from '@/components/column-filter';
import { EmployeeFormModal } from '@/components/employee-form';
import { DataTable, useListState, type Column } from '@/components/list';
import { useMe } from '@/components/me';
import { LocationSelect, useDepartments, useLocations } from '@/components/pickers';
import { UserFormModal, useSignInActions, type UserForm } from '@/components/user-account';
import { Badge, ErrorBox, PageHeader } from '@/components/ui';

interface Person {
  id: string; employeeId: string | null; userId: string | null; name: string; email: string | null; employeeCode: string | null; source: string | null;
  department: string | null; location: string | null; manager: string | null; employeeActive: boolean | null;
  role: string | null; userActive: boolean | null; userName: string | null; userEmail: string | null; userLocationId: string | null;
  lockedUntil: string | null; lastLoginAt: string | null; hasPassword: boolean | null; heldAssets: number;
}

const STATUS_OPTS = [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }, { value: 'all', label: 'Active and inactive' }];
const SIGNIN_OPTS = [...Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })), { value: 'ANY', label: 'Can sign in (any role)' }, { value: 'NONE', label: 'No sign-in' }];
const optLabel = (opts: { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;

function Inner() {
  const me = useMe();
  const router = useRouter();
  const defaults = useMemo(() => ({ active: 'true', sort: 'name', dir: 'asc' }), []);
  const ls = useListState(defaults);
  const { data, error, loading, reload } = useApi<{ rows: Person[]; total: number }>(`/api/people?${ls.apiQuery}`);
  const { data: depts } = useDepartments();
  const { data: locs } = useLocations();
  const [addEmp, setAddEmp] = useState(false);
  const [userDlg, setUserDlg] = useState<{ id?: string; initial: UserForm } | null>(null);
  const signIn = useSignInActions(reload);
  const showSignIn = me.isIT;

  const text = (k: string, placeholder: string): ColumnFilterDef => ({
    active: !!ls.get(k),
    content: (close) => <TextFilter value={ls.get(k)} placeholder={placeholder} onApply={(v) => ls.set(k, v)} close={close} />,
  });
  const option = (k: string, label: string, opts: { value: string; label: string }[], allLabel = 'All'): ColumnFilterDef => ({
    active: !!ls.get(k) && ls.get(k) !== defaults[k as keyof typeof defaults],
    content: (close) => <OptionFilter label={label} value={ls.get(k)} options={opts} allLabel={allLabel} onChange={(v) => ls.set(k, v ?? (k in defaults ? 'all' : null))} close={close} />,
  });
  const deptOpts = (depts ?? []).map((d) => ({ value: d.id, label: d.name }));

  const cols: Column<Person>[] = [
    { key: 'name', header: 'Name', sortable: true, filter: text('name', 'Name or email contains…'), render: (p) => (
      <span className="block">
        <span className="font-medium text-slate-900">{p.employeeId ? <Link href={`/employees/${p.employeeId}`}>{p.name}</Link> : p.name}</span>
        {p.employeeActive === false && <> <Badge>Inactive</Badge></>}{p.source === 'AD' && <> <Badge tone="blue">AD</Badge></>}
        {p.email && <span className="block text-xs text-slate-500">{p.email}</span>}
        {p.userEmail && p.userEmail !== p.email && <span className="block text-xs text-slate-500">Signs in as {p.userEmail}</span>}
      </span>
    ) },
    { key: 'employeeCode', header: 'Employee ID', sortable: true, filter: text('employeeCode', 'Employee ID contains…'), render: (p) => p.employeeCode ?? <Dash /> },
    { key: 'department', header: 'Department', filter: option('departmentId', 'Department', deptOpts, 'All departments'), render: (p) => p.department ?? <Dash /> },
    { key: 'location', header: 'Location', filter: {
      active: !!ls.get('locationId'),
      content: (close) => <SelectFilter label="Location (includes everything under it)"><LocationSelect value={ls.get('locationId')} onChange={(v) => { ls.set('locationId', v); close(); }} placeholder="All locations" /></SelectFilter>,
    }, render: (p) => <LocationCell path={p.location} /> },
    ...(showSignIn ? [{ key: 'role', header: 'Sign-in', sortable: true, filter: option('signIn', 'Sign-in', SIGNIN_OPTS, 'Everyone'), render: (p: Person) => !p.userId ? <span className="text-xs text-slate-400">No sign-in</span> : (
      <span className="flex flex-col items-start gap-1">
        <span className="whitespace-nowrap">{ROLE_LABEL[p.role ?? ''] ?? p.role}</span>
        <span className="flex flex-wrap gap-1">
          {!p.userActive && <Badge>Off</Badge>}
          {p.lockedUntil && new Date(p.lockedUntil) > new Date() && <Badge tone="red">Locked</Badge>}
          {!p.hasPassword && <Badge tone="amber">Invite pending</Badge>}
        </span>
        <span className="text-[11px] text-slate-500">{p.lastLoginAt ? `Last in ${fmtDateTime(p.lastLoginAt)}` : 'Never signed in'}</span>
      </span>
    ) } satisfies Column<Person>] : []),
    { key: 'status', header: 'Status', filter: option('active', 'Status', STATUS_OPTS.slice(0, 2), 'Active and inactive'), render: (p) => (p.employeeActive ?? p.userActive) ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge> },
    { key: 'heldAssets', header: 'Assets', sortable: true, className: 'text-right', filter: option('holding', 'Assets', [{ value: 'true', label: 'Holding assets' }], 'Everyone'), render: (p) => p.employeeId ? (p.heldAssets || '') : <Dash /> },
    ...(me.isAdmin ? [{ key: 'actions', header: '', className: 'text-right', render: (p: Person) => p.userId ? (
      <details className="relative inline-block text-left">
        <summary className="btn btn-sm list-none whitespace-nowrap">Sign-in ▾</summary>
        <div className="absolute right-0 z-20 mt-1 flex w-44 flex-col gap-1 rounded-md border bg-white p-2 shadow-lg [&>button]:justify-start">
          <button className="btn btn-sm" onClick={() => setUserDlg({ id: p.userId!, initial: { email: p.userEmail ?? '', name: p.userName ?? p.name, role: p.role ?? 'IT_OPERATOR', locationId: p.userLocationId ?? '', employee: p.employeeId ? { id: p.employeeId, label: `${p.name} (${p.employeeCode})` } : null } })}>Edit sign-in</button>
          {signIn.actions({ userId: p.userId, userEmail: p.userEmail ?? '', active: !!p.userActive, locked: !!p.lockedUntil && new Date(p.lockedUntil) > new Date(), hasPassword: !!p.hasPassword })}
        </div>
      </details>
    ) : p.employeeActive ? (
      <button className="btn btn-sm whitespace-nowrap" onClick={() => setUserDlg({ initial: { email: p.email ?? '', name: p.name, role: 'BRANCH_USER', locationId: '', employee: { id: p.employeeId!, label: `${p.name} (${p.employeeCode})` } } })}>Give sign-in</button>
    ) : null } satisfies Column<Person>] : []),
  ];

  const chips: FilterChip[] = [];
  const chip = (k: string, name: string, show = (v: string) => `“${v}”`) => { const v = ls.get(k); if (v && v !== defaults[k as keyof typeof defaults]) chips.push({ label: `${name}: ${show(v)}`, clear: () => ls.set(k, k in defaults ? 'all' : null) }); };
  chip('name', 'Name');
  chip('employeeCode', 'Employee ID');
  chip('departmentId', 'Department', (v) => deptOpts.find((d) => d.value === v)?.label ?? '…');
  chip('locationId', 'Location', (v) => locs?.find((l) => l.id === v)?.name ?? '…');
  if (showSignIn) chip('signIn', 'Sign-in', (v) => optLabel(SIGNIN_OPTS, v));
  chip('active', 'Status', (v) => optLabel(STATUS_OPTS, v));
  if (ls.get('holding')) chips.push({ label: 'Holding assets', clear: () => ls.set('holding', null) });

  return (
    <div className="space-y-4">
      {signIn.node}
      <PageHeader title="Users & Employees" subtitle="One row per person: employees who hold assets and the people who sign in."
        actions={<>
          {me.isIT && <Link href="/imports" className="btn">Import</Link>}
          {me.isAdmin && <button className="btn" onClick={() => setUserDlg({ initial: { email: '', name: '', role: 'IT_OPERATOR', locationId: '', employee: null } })}>Add sign-in</button>}
          {me.isIT && <button className="btn btn-primary" onClick={() => setAddEmp(true)}>Add employee</button>}
        </>} />
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onSort={(sort, dir) => ls.setMany({ sort, dir })} onPageSize={(n) => ls.set('pageSize', String(n))}
        columns={cols} empty="No one matches these filters."
        toolbar={<ActiveFilters chips={chips} onClearAll={ls.clear} />} />
      <EmployeeFormModal open={addEmp} onClose={() => setAddEmp(false)} onSaved={(e) => router.push(`/employees/${e.id}`)} />
      <UserFormModal open={!!userDlg} onClose={() => setUserDlg(null)} id={userDlg?.id} initial={userDlg?.initial} onSaved={reload} />
    </div>
  );
}
export default function PeoplePage() { return <Suspense><Inner /></Suspense>; }
