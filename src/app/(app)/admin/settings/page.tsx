'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/components/api';
import { Card, ErrorBox, Field, PageHeader, Spinner, useToast } from '@/components/ui';

interface S {
  orgName: string; sessionIdleMinutes: number; sessionAbsoluteHours: number; lockoutThreshold: number; lockoutMinutes: number; passwordMinLength: number; transferAgingDays: number;
  duplicateRules: { serial: 'BLOCK'; hostname: 'BLOCK' | 'WARN' | 'OFF'; ip: 'BLOCK' | 'WARN' | 'OFF' }; maxFileSizeMB: number; maxFilesPerRecord: number; allowedFileTypes: string[]; imageMaxDimension: number;
  documentRetentionYears: number; auditRetentionYears: number; importReportRetentionMonths: number; scannerAdvanceKey: 'Enter' | 'Tab'; verificationReminderDays: number[]; notificationEmail: Record<string, boolean>;
}
const NOTIF: Record<string, string> = {
  TRANSFER_APPROVAL_REQUESTED: 'Transfer awaiting approval', TRANSFER_DECIDED: 'Transfer approved or rejected', TRANSFER_IN_TRANSIT: 'Transfer dispatched (to receiver)', TRANSFER_EXCEPTION: 'Transfer line not received',
  TRANSFER_RECEIVED: 'Transfer lines received', TRANSFER_COMPLETED: 'Transfer completed', TRANSFER_AGING: 'Transfer overdue in transit', APPROVAL_REQUESTED: 'Approval requested', APPROVAL_DECIDED: 'Approval decided',
  VERIFICATION: 'Campaign tasks and reminders', RENEWAL: 'Renewal reminders', INTEGRATION_FAILURE: 'Integration failures', IMPORT_COMPLETED: 'Import finished',
};

export default function SettingsPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<S>('/api/settings');
  const [s, setS] = useState<S | null>(null);
  const [verDays, setVerDays] = useState('');
  const [types, setTypes] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setS(data); setVerDays(data.verificationReminderDays.join(', ')); setTypes(data.allowedFileTypes.join('\n')); } }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!s) return <div className="flex justify-center py-20"><Spinner /></div>;
  const num = (k: keyof S) => ({ type: 'number', className: 'input', value: s[k] as number, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) }) });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { orgName, sessionIdleMinutes, sessionAbsoluteHours, lockoutThreshold, lockoutMinutes, passwordMinLength, transferAgingDays, duplicateRules, maxFileSizeMB, maxFilesPerRecord, imageMaxDimension, documentRetentionYears, auditRetentionYears, importReportRetentionMonths, scannerAdvanceKey, notificationEmail } = s;
      await api('/api/settings', { method: 'PATCH', body: {
        orgName, sessionIdleMinutes, sessionAbsoluteHours, lockoutThreshold, lockoutMinutes, passwordMinLength, transferAgingDays, duplicateRules, maxFileSizeMB, maxFilesPerRecord, imageMaxDimension,
        documentRetentionYears, auditRetentionYears, importReportRetentionMonths, scannerAdvanceKey, notificationEmail,
        verificationReminderDays: verDays.split(/[,\s]+/).filter(Boolean).map(Number), allowedFileTypes: types.split(/\s+/).filter(Boolean),
      } });
      toast('Settings saved'); reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Settings" subtitle="Organisation-wide rules. Every change is recorded in the audit log." actions={<button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner className="h-3 w-3" />}Save</button>} />
      <ErrorBox error={err} />
      <Card title="Organisation"><Field label="Organisation name"><input className="input" value={s.orgName} onChange={(e) => setS({ ...s, orgName: e.target.value })} /></Field></Card>
      <Card title="Sign-in and sessions">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Idle timeout (minutes)"><input {...num('sessionIdleMinutes')} min={5} max={480} /></Field>
          <Field label="Maximum session (hours)"><input {...num('sessionAbsoluteHours')} min={1} max={72} /></Field>
          <Field label="Minimum password length"><input {...num('passwordMinLength')} min={8} max={64} /></Field>
          <Field label="Failed attempts before lockout"><input {...num('lockoutThreshold')} min={3} max={20} /></Field>
          <Field label="Lockout duration (minutes)"><input {...num('lockoutMinutes')} min={1} max={1440} /></Field>
        </div>
      </Card>
      <Card title="Assets">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Duplicate serial number"><select className="input" disabled><option>Block (always)</option></select></Field>
          {(['hostname', 'ip'] as const).map((k) => <Field key={k} label={`Duplicate ${k === 'ip' ? 'IP address' : 'hostname'}`}><select className="input" value={s.duplicateRules[k]} onChange={(e) => setS({ ...s, duplicateRules: { ...s.duplicateRules, [k]: e.target.value } })}><option value="BLOCK">Block</option><option value="WARN">Warn and ask for a reason</option><option value="OFF">Allow</option></select></Field>)}
          <Field label="Scanner advance key"><select className="input" value={s.scannerAdvanceKey} onChange={(e) => setS({ ...s, scannerAdvanceKey: e.target.value as 'Enter' })}><option>Enter</option><option>Tab</option></select></Field>
          <Field label="Campaign reminders (days before due)"><input className="input" value={verDays} onChange={(e) => setVerDays(e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Documents">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Maximum file size (MB)"><input {...num('maxFileSizeMB')} step={0.5} min={0.5} max={50} /></Field>
          <Field label="Maximum files per record"><input {...num('maxFilesPerRecord')} min={1} max={200} /></Field>
          <Field label="Images resized to (px, longest side)"><input {...num('imageMaxDimension')} min={320} max={8000} /></Field>
        </div>
        <Field label="Allowed file types (MIME types, one per line)" className="mt-3"><textarea className="input font-mono text-xs" rows={5} value={types} onChange={(e) => setTypes(e.target.value)} /></Field>
      </Card>
      <Card title="Retention">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Deleted documents kept (years)"><input {...num('documentRetentionYears')} min={1} max={30} /></Field>
          <Field label="Audit log kept (years, minimum 7)"><input {...num('auditRetentionYears')} min={7} max={50} /></Field>
          <Field label="Import reports kept (months)"><input {...num('importReportRetentionMonths')} min={12} max={120} /></Field>
        </div>
      </Card>
      <Card title="Email notifications" >
        <p className="mb-2 text-xs text-slate-500">In-app notifications are always sent. Tick the events that should also send email.</p>
        <div className="grid gap-2 sm:grid-cols-2">{Object.entries(NOTIF).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!s.notificationEmail[k]} onChange={(e) => setS({ ...s, notificationEmail: { ...s.notificationEmail, [k]: e.target.checked } })} />{l}</label>
        ))}</div>
      </Card>
    </div>
  );
}
