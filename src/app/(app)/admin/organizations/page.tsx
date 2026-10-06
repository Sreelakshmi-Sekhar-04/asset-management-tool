'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, useApi } from '@/components/api';
import { useMe } from '@/components/me';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';

type Org = { id: string; name: string; active: boolean; locations: number; employees: number; assets: number };
type Form = { id?: string; name: string; active: boolean };

/**
 * Configuration → Organizations: the one place organizations (head quarters) are created and
 * edited. Locations, departments, employees and assets then belong to the organization that is
 * selected in the header.
 */
export default function OrganizationsPage() {
  const toast = useToast();
  const me = useMe();
  const { confirm, node } = useConfirm();
  const { data, error, reload } = useApi<Org[]>('/api/organizations?manage=true');
  const [edit, setEdit] = useState<Form | null>(null);
  // The header picker lists organizations, so a change here needs a reload to show up there.
  const refresh = () => window.location.reload();
  const toggle = async (o: Org) => {
    if (o.active && !(await confirm(`Deactivate ${o.name}? It is no longer offered in the organization selector. Its history is kept.`))) return;
    try { await api(`/api/organizations/${o.id}`, { method: 'PATCH', body: { active: !o.active } }); toast(o.active ? 'Deactivated' : 'Activated'); refresh(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="space-y-4">
      {node}
      <PageHeader title="Organizations"
        subtitle="Each organization is a head quarter. Choose one in the selector at the top of the page, and every screen shows that organization's locations, departments, employees and assets."
        actions={<button className="btn btn-primary" onClick={() => setEdit({ name: '', active: true })}>Add organization</button>} />
      <ErrorBox error={error} />
      <Card bodyClass="p-0">
        {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Organization</th><th>Status</th><th>Locations</th><th>Employees</th><th>Assets</th><th /></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className={o.active ? '' : 'text-slate-400'}>
                  <td className="font-medium">{o.name} {me.organization?.id === o.id && <Badge tone="blue">Selected</Badge>}</td>
                  <td>{o.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td>{o.locations}</td>
                  <td>{o.employees}</td>
                  <td>{o.assets}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn btn-sm btn-ghost" onClick={() => setEdit({ id: o.id, name: o.name, active: o.active })}>Edit</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => toggle(o)}>{o.active ? 'Deactivate' : 'Activate'}</button>
                  </td>
                </tr>
              ))}
              {!data.length && <tr><td colSpan={6} className="py-6 text-center text-slate-500">No organizations yet. Add the first one to get started.</td></tr>}
            </tbody>
          </table></div>
        )}
      </Card>
      <p className="text-xs text-slate-500">Add the locations of the selected organization under <Link href="/admin/locations">Configuration → Locations</Link>.</p>
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit organization' : 'Add organization'}
        onSubmit={async () => {
          const body = { name: edit!.name, active: edit!.active };
          if (edit!.id) await api(`/api/organizations/${edit!.id}`, { method: 'PATCH', body }); else await api('/api/organizations', { body });
          toast('Saved');
          if (edit!.id) refresh(); else { reload(); refresh(); }
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
