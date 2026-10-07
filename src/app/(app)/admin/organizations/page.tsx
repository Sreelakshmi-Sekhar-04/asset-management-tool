'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, useApi } from '@/components/api';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useToast } from '@/components/ui';

type Org = { id: string; name: string; active: boolean; locations: number; employees: number; assets: number };
type Form = { id?: string; name: string; active: boolean };

/**
 * Configuration → Organizations. The application currently works with one organization, Joy
 * Alukkas (the head quarter), so there is no selector and no "Add": it is viewed and edited here,
 * and every location, department, employee and asset belongs to it.
 */
export default function OrganizationsPage() {
  const toast = useToast();
  const { data, error } = useApi<Org[]>('/api/organizations?manage=true');
  const [edit, setEdit] = useState<Form | null>(null);
  // The organization's name is shown across the application, so a change here reloads the page.
  const refresh = () => window.location.reload();
  return (
    <div className="space-y-4">
      <PageHeader title="Organizations"
        subtitle="The organization is the head quarter. Every location, department, employee and asset in the application belongs to it." />
      <ErrorBox error={error} />
      <Card bodyClass="p-0">
        {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Organization</th><th>Status</th><th>Locations</th><th>Employees</th><th>Assets</th><th /></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className={o.active ? '' : 'text-slate-400'}>
                  <td className="font-medium">{o.name}</td>
                  <td>{o.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td>{o.locations}</td>
                  <td>{o.employees}</td>
                  <td>{o.assets}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEdit({ id: o.id, name: o.name, active: o.active })}>Edit</button>
                  </td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={6} className="py-6 text-center text-slate-500">No organization yet. Run the migrations or the demo seed to create Joy Alukkas.</td></tr>}
            </tbody>
          </table></div>
        )}
      </Card>
      <p className="text-xs text-slate-500">Add the organization&apos;s locations under <Link href="/admin/locations">Configuration → Locations</Link>.</p>
      <FormModal open={!!edit} onClose={() => setEdit(null)} title="Edit organization"
        onSubmit={async () => {
          const body = { name: edit!.name, active: edit!.active };
          await api(`/api/organizations/${edit!.id}`, { method: 'PATCH', body });
          toast('Saved');
          refresh();
        }}>
        {edit && <>
          <Field label="Organization name" required><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={120} /></Field>
          <Field label="Status">
            <select className="input" value={edit.active ? 'ACTIVE' : 'INACTIVE'} onChange={(e) => setEdit({ ...edit, active: e.target.value === 'ACTIVE' })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </Field>
        </>}
      </FormModal>
    </div>
  );
}
