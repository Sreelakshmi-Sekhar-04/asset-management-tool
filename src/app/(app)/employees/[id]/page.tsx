'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, ApiError, useApi } from '@/components/api';
import { AssetStatus } from '@/components/badges';
import { EmployeeFormModal, type EmpValues } from '@/components/employee-form';
import { useMe } from '@/components/me';
import { EmployeePicker } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';

interface Emp {
  id: string; employeeCode: string; name: string; email: string | null; active: boolean; source: string; departmentId: string | null; locationId: string | null; managerId: string | null;
  department: { name: string } | null; location: { namePath: string } | null; manager: { id: string; name: string; employeeCode: string } | null;
  heldAssets: { id: string; assetCode: string; make: string; model: string; status: string; serialNumber: string | null }[];
}

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const { data: e, error, reload } = useApi<Emp>(`/api/employees/${id}`);
  const [edit, setEdit] = useState(false);
  const [off, setOff] = useState(false);
  const [o, setO] = useState<{ action: 'CHECK_IN' | 'REASSIGN'; to: { id: string; label: string } | null; condition: string; remarks: string; deactivate: boolean }>({ action: 'CHECK_IN', to: null, condition: '', remarks: '', deactivate: true });
  const initial = useMemo<EmpValues | undefined>(() => e ? { employeeCode: e.employeeCode, name: e.name, email: e.email ?? '', departmentId: e.departmentId ?? '', locationId: e.locationId ?? '', manager: e.manager ? { id: e.manager.id, label: `${e.manager.name} (${e.manager.employeeCode})` } : null } : undefined, [e]);
  if (error) return <ErrorBox error={error} />;
  if (!e) return <div className="flex justify-center py-20"><Spinner /></div>;

  const setActive = async (active: boolean) => {
    const go = async (force: boolean) => api(`/api/employees/${id}${force ? '?confirmDeactivate=true' : ''}`, { method: 'PATCH', body: { active } });
    try { await go(false); toast(active ? 'Reactivated' : 'Deactivated'); reload(); }
    catch (x) {
      if (x instanceof ApiError && (x.details as { code?: string })?.code === 'EMPLOYEE_HOLDS_ASSETS') {
        if (await confirm(<>{x.message}</>)) { await go(true).catch((y) => toast(y.message, 'err')); toast('Deactivated'); reload(); }
      } else toast((x as Error).message, 'err');
    }
  };

  return (
    <div className="space-y-4">
      {node}
      <PageHeader back={{ href: '/employees', label: 'Users & Employees' }} title={e.name}
        subtitle={<span className="flex items-center gap-2">{e.employeeCode}{!e.active && <Badge>Inactive</Badge>}{e.source === 'AD' && <Badge tone="blue">Synced from AD</Badge>}</span>}
        actions={me.isIT && <>
          {e.heldAssets.length > 0 && <button className="btn btn-primary" onClick={() => setOff(true)}>Offboard</button>}
          <button className="btn" onClick={() => setEdit(true)}>Edit</button>
          {e.active ? <button className="btn btn-ghost text-red-600" onClick={() => setActive(false)}>Deactivate</button> : <button className="btn" onClick={() => setActive(true)}>Reactivate</button>}
        </>} />
      <Card title="Details">
        <dl className="kv">
          <dt>Email</dt><dd>{e.email ?? '—'}</dd>
          <dt>Department</dt><dd>{e.department?.name ?? '—'}</dd>
          <dt>Location</dt><dd>{e.location?.namePath ?? '—'}</dd>
          <dt>Manager</dt><dd>{e.manager ? <Link href={`/employees/${e.manager.id}`}>{e.manager.name}</Link> : '—'}</dd>
        </dl>
      </Card>
      <Card title={`Assets held (${e.heldAssets.length})`}>
        {e.heldAssets.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Asset ID</th><th>Item</th><th>Serial</th><th>Status</th></tr></thead>
            <tbody>{e.heldAssets.map((a) => <tr key={a.id}><td><Link href={`/assets/${a.id}`}>{a.assetCode}</Link></td><td>{a.make} {a.model}</td><td>{a.serialNumber ?? '—'}</td><td><AssetStatus s={a.status} /></td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      <EmployeeFormModal open={edit} id={e.id} initial={initial} onClose={() => setEdit(false)} onSaved={() => { toast('Saved'); reload(); }} />
      <FormModal open={off} onClose={() => setOff(false)} title={`Offboard ${e.name}`} submitLabel="Offboard"
        onSubmit={async () => {
          const r = await api<{ checkedIn?: number; reassigned?: number; pendingApproval?: { requestNo: string } }>(`/api/employees/${id}/offboard`, { body: { action: o.action, toEmployeeId: o.to?.id, condition: o.condition || undefined, remarks: o.remarks || undefined, deactivate: o.deactivate } });
          toast(r.pendingApproval ? `Submitted for approval (${r.pendingApproval.requestNo})` : `Done: ${r.checkedIn ?? r.reassigned ?? 0} asset(s) ${o.action === 'CHECK_IN' ? 'checked in' : 'reassigned'}`); reload();
        }}>
        <p className="text-sm text-slate-600">Applies to all {e.heldAssets.length} asset(s) held. If an approval policy applies, one approval request covers all of them.</p>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={o.action === 'CHECK_IN'} onChange={() => setO({ ...o, action: 'CHECK_IN' })} />Check all in to stock</label>
          <label className="flex items-center gap-1"><input type="radio" checked={o.action === 'REASSIGN'} onChange={() => setO({ ...o, action: 'REASSIGN' })} />Reassign all to another employee</label>
        </div>
        {o.action === 'REASSIGN' ? <Field label="Reassign to" required><EmployeePicker value={o.to} onChange={(to) => setO({ ...o, to })} /></Field>
          : <Field label="Condition on return"><input className="input" value={o.condition} onChange={(x) => setO({ ...o, condition: x.target.value })} /></Field>}
        <Field label="Remarks"><input className="input" value={o.remarks} onChange={(x) => setO({ ...o, remarks: x.target.value })} placeholder={`Offboarding of ${e.name}`} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={o.deactivate} onChange={(x) => setO({ ...o, deactivate: x.target.checked })} />Deactivate the employee afterwards</label>
      </FormModal>
    </div>
  );
}
