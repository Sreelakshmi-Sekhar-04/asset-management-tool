'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/me';
import { LocationSelect, useLocations, type Loc } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';

// Every location sits under an organization (head quarter). Organizations themselves are created
// under Configuration → Organizations, not here.
const TYPES = ['REGION', 'STATE', 'BRANCH', 'SITE', 'OTHER'];
type Form = { name: string; type: string; parentId: string; state: string; code: string; email: string };

export default function LocationsPage() {
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const me = useMe();
  const { data, error, reload } = useLocations(true, true);
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const [filter, setFilter] = useState('');
  const open = (l?: Loc, parent?: Loc) => setEdit(l
    ? { id: l.id, f: { name: l.name, type: l.type, parentId: l.parentId ?? '', state: l.state ?? '', code: l.code ?? '', email: l.email ?? '' } }
    : { f: { name: '', type: 'BRANCH', parentId: parent?.id ?? me.organization?.id ?? '', state: '', code: '', email: '' } });
  const toggle = async (l: Loc) => {
    if (l.active && !(await confirm(`Deactivate ${l.namePath}? Inactive locations can’t receive assets or transfers. History is kept.`))) return;
    try { await api(`/api/locations/${l.id}`, { method: 'PATCH', body: { active: !l.active } }); toast(l.active ? 'Deactivated' : 'Activated'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const f = edit?.f;
  const set = (p: Partial<Form>) => edit && setEdit({ ...edit, f: { ...edit.f, ...p } });
  const rows = (data ?? []).filter((l) => !filter || l.namePath.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-4">
      {node}
      <PageHeader title="Locations" subtitle={<>The locations of {me.organization?.name ?? 'the selected organization'}. Organizations themselves are managed under <Link href="/admin/organizations">Configuration → Organizations</Link>. Branch users see their own location and everything under it. Moving a location keeps every Asset ID unchanged.</>}
        actions={<button className="btn btn-primary" onClick={() => open()} disabled={!me.organization}>Add location</button>} />
      <input className="input max-w-sm" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ErrorBox error={error} />
      <Card bodyClass="p-0">
        {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Location</th><th>Type</th><th>State (GST)</th><th>Code</th><th>Assets here</th><th /></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.id} className={l.active ? '' : 'text-slate-400'}>
                <td style={{ paddingLeft: `${0.75 + l.depth * 1.25}rem` }}>{l.name} {!l.active && <Badge>Inactive</Badge>}</td>
                <td className="text-xs">{l.type.toLowerCase()}</td>
                <td className="text-xs">{l.state ?? (l.effectiveState ? <span className="text-slate-400">{l.effectiveState} (inherited)</span> : '—')}</td>
                <td className="text-xs">{l.code ?? ''}</td>
                <td>{l.assetCount ?? ''}</td>
                <td className="whitespace-nowrap text-right">
                  {l.active && <button className="btn btn-sm btn-ghost" onClick={() => open(undefined, l)}>Add child</button>}
                  {l.type === 'ORGANIZATION' ? <Link className="btn btn-sm btn-ghost" href="/admin/organizations">Manage organization</Link> : <>
                    <button className="btn btn-sm btn-ghost" onClick={() => open(l)}>Edit</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => toggle(l)}>{l.active ? 'Deactivate' : 'Activate'}</button>
                  </>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit location' : 'Add location'}
        onSubmit={async () => {
          const body = { name: f!.name, type: f!.type, parentId: f!.parentId || null, state: f!.state || null, code: f!.code || null, email: f!.email || null };
          if (edit!.id) await api(`/api/locations/${edit!.id}`, { method: 'PATCH', body }); else await api('/api/locations', { body });
          toast('Saved'); reload();
        }}>
        {f && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
          <Field label="Type"><select className="input" value={f.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t[0] + t.slice(1).toLowerCase()}</option>)}</select></Field>
          <Field label="Parent" required hint={edit?.id ? 'Changing the parent moves this location and everything beneath it' : undefined}><LocationSelect value={f.parentId} onChange={(parentId) => set({ parentId })} placeholder="Choose the parent" all /></Field>
          <Field label="State" hint="Set on a state node or branch; used to flag inter-state transfers"><input className="input" value={f.state} onChange={(e) => set({ state: e.target.value })} /></Field>
          <Field label="Code"><input className="input" value={f.code} onChange={(e) => set({ code: e.target.value })} /></Field>
          <Field label="Branch email" hint="Receives transfer notifications"><input className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        </div>}
      </FormModal>
    </div>
  );
}
