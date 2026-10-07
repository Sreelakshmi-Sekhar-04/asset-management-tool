'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, useApi } from '@/components/api';
import { DepartmentFormModal } from '@/components/master-forms';
import type { Cat, Dept } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, useToast } from '@/components/ui';

type CatForm = { name: string; code: string; serialRequired: boolean; individuallyTracked: boolean; isSoftware: boolean };

export default function MasterDataPage() {
  const toast = useToast();
  const cats = useApi<Cat[]>('/api/categories?includeInactive=true');
  const depts = useApi<(Dept & { employeeCount?: number })[]>('/api/departments?includeInactive=true');
  const [cat, setCat] = useState<{ id?: string; f: CatForm } | null>(null);
  const [dept, setDept] = useState<{ id?: string; name: string } | null>(null);
  const toggle = async (kind: 'categories' | 'departments', id: string, active: boolean) => {
    try { await api(`/api/${kind}/${id}`, { method: 'PATCH', body: { active } }); toast(active ? 'Activated' : 'Deactivated'); (kind === 'categories' ? cats : depts).reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Categories and departments" subtitle="Values used in forms and imports. Values in use can be deactivated but not deleted, so history stays intact." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Asset categories" actions={<button className="btn btn-sm btn-primary" onClick={() => setCat({ f: { name: '', code: '', serialRequired: true, individuallyTracked: true, isSoftware: false } })}>Add</button>} bodyClass="p-0">
          <ErrorBox error={cats.error} />
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Name</th><th>Code</th><th>Rules</th><th>Assets</th><th /></tr></thead>
            <tbody>{(cats.data ?? []).map((c) => (
              <tr key={c.id} className={c.active ? '' : 'text-slate-400'}>
                <td>{c.name} {!c.active && <Badge>Inactive</Badge>}</td>
                <td className="font-mono text-xs">{c.code ?? '—'}</td>
                <td className="text-xs">{[c.serialRequired && 'serial required', c.individuallyTracked ? 'individually tracked' : 'bulk', c.isSoftware && 'software'].filter(Boolean).join(', ')}</td>
                <td>{c.assetCount}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn btn-sm btn-ghost" onClick={() => setCat({ id: c.id, f: { name: c.name, code: c.code ?? '', serialRequired: c.serialRequired, individuallyTracked: c.individuallyTracked, isSoftware: c.isSoftware } })}>Edit</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggle('categories', c.id, !c.active)}>{c.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
        <Card title="Departments" actions={<button className="btn btn-sm btn-primary" onClick={() => setDept({ name: '' })}>Add</button>} bodyClass="p-0">
          <ErrorBox error={depts.error} />
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Name</th><th /></tr></thead>
            <tbody>{(depts.data ?? []).map((d) => (
              <tr key={d.id} className={d.active ? '' : 'text-slate-400'}>
                <td>{d.name} {!d.active && <Badge>Inactive</Badge>}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn btn-sm btn-ghost" onClick={() => setDept({ id: d.id, name: d.name })}>Rename</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggle('departments', d.id, !d.active)}>{d.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      </div>
      <FormModal open={!!cat} onClose={() => setCat(null)} title={cat?.id ? 'Edit category' : 'Add category'}
        onSubmit={async () => { const body = { ...cat!.f, code: cat!.f.code.trim() || null }; if (cat!.id) await api(`/api/categories/${cat!.id}`, { method: 'PATCH', body }); else await api('/api/categories', { body }); toast('Saved'); cats.reload(); }}>
        {cat && <>
          <Field label="Name" required><input className="input" value={cat.f.name} onChange={(e) => setCat({ ...cat, f: { ...cat.f, name: e.target.value } })} required /></Field>
          <Field label="Code" hint={<>Optional, up to 6 letters or digits, e.g. LAP. Used in new Asset IDs when the <Link href="/admin/asset-ids">Asset ID format</Link> includes the category code.</>}>
            <input className="input font-mono uppercase" value={cat.f.code} maxLength={6} onChange={(e) => setCat({ ...cat, f: { ...cat.f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') } })} />
          </Field>
          {([['serialRequired', 'Serial number required'], ['individuallyTracked', 'Tracked individually (one record per item)'], ['isSoftware', 'Software / licence category']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cat.f[k]} onChange={(e) => setCat({ ...cat, f: { ...cat.f, [k]: e.target.checked } })} />{l}</label>
          ))}
        </>}
      </FormModal>
      <DepartmentFormModal value={dept} onClose={() => setDept(null)} onSaved={() => { toast('Saved'); depts.reload(); }} />
    </div>
  );
}
