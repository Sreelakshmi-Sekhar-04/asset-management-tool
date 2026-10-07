'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/me';
import { LocationFormModal, emptyLocationForm, type LocationForm } from '@/components/master-forms';
import { useLocations, type Loc } from '@/components/pickers';
import { Badge, Card, ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';


export default function LocationsPage() {
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const me = useMe();
  const { data, error, reload } = useLocations(true, true);
  const [edit, setEdit] = useState<{ id?: string; f: LocationForm } | null>(null);
  const [filter, setFilter] = useState('');
  const open = (l?: Loc, parent?: Loc) => setEdit(l
    ? { id: l.id, f: { name: l.name, type: l.type, parentId: l.parentId ?? '', state: l.state ?? '', code: l.code ?? '', email: l.email ?? '', managerId: l.managerId ?? '' } }
    : { f: emptyLocationForm({ parentId: parent?.id ?? me.organization?.id ?? '' }) });
  const toggle = async (l: Loc) => {
    if (l.active && !(await confirm(`Deactivate ${l.namePath}? Inactive locations can’t receive assets or transfers. History is kept.`))) return;
    try { await api(`/api/locations/${l.id}`, { method: 'PATCH', body: { active: !l.active } }); toast(l.active ? 'Deactivated' : 'Activated'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
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
            <thead><tr><th>Location</th><th>Type</th><th>State (GST)</th><th>Code</th><th>Location manager</th><th>Assets here</th><th /></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.id} className={l.active ? '' : 'text-slate-400'}>
                <td style={{ paddingLeft: `${0.75 + l.depth * 1.25}rem` }}>{l.name} {!l.active && <Badge>Inactive</Badge>}</td>
                <td className="text-xs">{l.type.toLowerCase()}</td>
                <td className="text-xs">{l.state ?? (l.effectiveState ? <span className="text-slate-400">{l.effectiveState} (inherited)</span> : '—')}</td>
                <td className="text-xs">{l.code ?? ''}</td>
                <td className="text-xs">{l.managerName ?? <span className="text-slate-400">{inheritedManager(l, data ?? []) ? `${inheritedManager(l, data ?? [])} (inherited)` : 'Not set'}</span>}</td>
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
      <LocationFormModal value={edit} onClose={() => setEdit(null)} onSaved={() => { toast('Saved'); reload(); }} />
    </div>
  );
}

/** The manager a location without its own inherits from the nearest location above it. */
function inheritedManager(l: Loc, all: Loc[]): string | null {
  const byId = new Map(all.map((x) => [x.id, x]));
  let cur = l.parentId ? byId.get(l.parentId) : undefined;
  while (cur) {
    if (cur.managerName) return cur.managerName;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}
