'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { DepartmentSelect, EmployeePicker, LocationSelect } from './pickers';
import { Field, FormModal } from './ui';

export interface EmpValues { employeeCode: string; name: string; email: string; departmentId: string; locationId: string; manager: { id: string; label: string } | null }
export const emptyEmp: EmpValues = { employeeCode: '', name: '', email: '', departmentId: '', locationId: '', manager: null };

export function EmployeeFormModal({ open, onClose, id, initial, onSaved }: { open: boolean; onClose: () => void; id?: string; initial?: EmpValues; onSaved: (e: { id: string }) => void }) {
  const [v, setV] = useState<EmpValues>(initial ?? emptyEmp);
  useEffect(() => { if (open) setV(initial ?? emptyEmp); }, [open, initial]);
  return (
    <FormModal open={open} onClose={onClose} title={id ? 'Edit employee' : 'Add employee'} submitLabel={id ? 'Save' : 'Add'} wide
      onSubmit={async () => {
        const body = { employeeCode: v.employeeCode, name: v.name, email: v.email || null, departmentId: v.departmentId || null, locationId: v.locationId || null, managerId: v.manager?.id ?? null };
        onSaved(id ? await api<{ id: string }>(`/api/employees/${id}`, { method: 'PATCH', body }) : await api<{ id: string }>('/api/employees', { body }));
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee ID" required><input className="input" value={v.employeeCode} onChange={(e) => setV({ ...v, employeeCode: e.target.value })} required /></Field>
        <Field label="Name" required><input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required /></Field>
        <Field label="Email"><input className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Department"><DepartmentSelect value={v.departmentId} onChange={(departmentId) => setV({ ...v, departmentId })} placeholder="None" /></Field>
        <Field label="Location"><LocationSelect value={v.locationId} onChange={(locationId) => setV({ ...v, locationId })} placeholder="None" /></Field>
        <Field label="Manager"><EmployeePicker value={v.manager} onChange={(manager) => setV({ ...v, manager })} /></Field>
      </div>
    </FormModal>
  );
}
