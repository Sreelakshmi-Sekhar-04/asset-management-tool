'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useApi } from '@/components/api';
import { EmployeeFormModal } from '@/components/employee-form';
import { DataTable, FilterSelect, SearchBox, useListState } from '@/components/list';
import { useMe } from '@/components/me';
import { DepartmentSelect, LocationSelect } from '@/components/pickers';
import { Badge, ErrorBox, PageHeader } from '@/components/ui';

interface Emp { id: string; employeeCode: string; name: string; email: string | null; active: boolean; source: string; department: { name: string } | null; location: { namePath: string } | null; manager: { id: string; name: string } | null; _count: { heldAssets: number } }

function Inner() {
  const me = useMe();
  const router = useRouter();
  const defaults = useMemo(() => ({ active: 'true', sort: 'name', dir: 'asc' }), []);
  const ls = useListState(defaults);
  const [add, setAdd] = useState(false);
  const { data, error, loading } = useApi<{ rows: Emp[]; total: number }>(`/api/employees?${ls.apiQuery}`);
  return (
    <div className="space-y-4">
      <PageHeader title="Employees" subtitle="People who can hold assets. Directory-synced records are marked AD."
        actions={me.isIT && <><Link href="/imports" className="btn">Import</Link><button className="btn btn-primary" onClick={() => setAdd(true)}>Add employee</button></>} />
      <div className="flex flex-wrap gap-2">
        <SearchBox value={ls.get('search')} onChange={(v) => ls.set('search', v)} placeholder="Name, employee ID or email" />
        <div className="w-48"><DepartmentSelect value={ls.get('departmentId')} onChange={(v) => ls.set('departmentId', v)} placeholder="All departments" /></div>
        <div className="w-56"><LocationSelect value={ls.get('locationId')} onChange={(v) => ls.set('locationId', v)} placeholder="All locations" /></div>
        <FilterSelect label="Status" value={ls.get('active')} onChange={(v) => ls.set('active', v || 'all')} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }, { value: 'all', label: 'All' }]} />
        <FilterSelect label="Assets" value={ls.get('holding')} onChange={(v) => ls.set('holding', v)} options={[{ value: 'true', label: 'Holding assets' }]} />
      </div>
      <ErrorBox error={error} />
      <DataTable loading={loading} rows={data?.rows ?? []} total={data?.total ?? 0} page={ls.page} pageSize={ls.pageSize} sort={ls.sort} dir={ls.dir}
        onPage={(p) => ls.setMany({ page: String(p) }, false)} onSort={(sort, dir) => ls.setMany({ sort, dir })} onPageSize={(n) => ls.set('pageSize', String(n))}
        columns={[
          { key: 'employeeCode', header: 'Employee ID', sortable: true, render: (e) => <Link href={`/employees/${e.id}`}>{e.employeeCode}</Link> },
          { key: 'name', header: 'Name', sortable: true, render: (e) => <span>{e.name} {!e.active && <Badge>Inactive</Badge>} {e.source === 'AD' && <Badge tone="blue">AD</Badge>}</span> },
          { key: 'email', header: 'Email', sortable: true, render: (e) => e.email ?? '—' },
          { key: 'department', header: 'Department', render: (e) => e.department?.name ?? '—' },
          { key: 'location', header: 'Location', render: (e) => <span className="text-xs">{e.location?.namePath ?? '—'}</span> },
          { key: 'manager', header: 'Manager', render: (e) => e.manager?.name ?? '—' },
          { key: 'assets', header: 'Assets held', className: 'text-right', render: (e) => e._count.heldAssets || '' },
        ]} />
      <EmployeeFormModal open={add} onClose={() => setAdd(false)} onSaved={(e) => router.push(`/employees/${e.id}`)} />
    </div>
  );
}
export default function EmployeesPage() { return <Suspense><Inner /></Suspense>; }
