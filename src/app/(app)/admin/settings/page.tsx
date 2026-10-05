'use client';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ASSET_ID_TOKENS, DEFAULT_ASSET_ID_FORMAT, formatAssetId, validateAssetIdFormat, type AssetIdFormat } from '@/lib/asset-id';
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
  VERIFICATION: 'Verification tasks and reminders', RENEWAL: 'Renewal reminders', INTEGRATION_FAILURE: 'Integration failures', IMPORT_COMPLETED: 'Import finished',
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
      <AssetIdFormatCard />
      <Card title="Sign-in and sessions">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Idle timeout (minutes)"><input {...num('sessionIdleMinutes')} min={5} max={480} /></Field>
          <Field label="Maximum session (hours)"><input {...num('sessionAbsoluteHours')} min={1} max={72} /></Field>
          <Field label="Minimum password length"><input {...num('passwordMinLength')} min={8} max={64} /></Field>
          <Field label="Failed attempts before lockout"><input {...num('lockoutThreshold')} min={3} max={20} /></Field>
          <Field label="Lockout duration (minutes)"><input {...num('lockoutMinutes')} min={1} max={1440} /></Field>
        </div>
      </Card>
      <Card title="Assets and transfers">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Duplicate serial number"><select className="input" disabled><option>Block (always)</option></select></Field>
          {(['hostname', 'ip'] as const).map((k) => <Field key={k} label={`Duplicate ${k === 'ip' ? 'IP address' : 'hostname'}`}><select className="input" value={s.duplicateRules[k]} onChange={(e) => setS({ ...s, duplicateRules: { ...s.duplicateRules, [k]: e.target.value } })}><option value="BLOCK">Block</option><option value="WARN">Warn and ask for a reason</option><option value="OFF">Allow</option></select></Field>)}
          <Field label="Transfer aging threshold (days in transit)"><input {...num('transferAgingDays')} min={1} max={365} /></Field>
          <Field label="Scanner advance key"><select className="input" value={s.scannerAdvanceKey} onChange={(e) => setS({ ...s, scannerAdvanceKey: e.target.value as 'Enter' })}><option>Enter</option><option>Tab</option></select></Field>
          <Field label="Verification reminders (days before due)"><input className="input" value={verDays} onChange={(e) => setVerDays(e.target.value)} /></Field>
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

interface IdConfig { format: AssetIdFormat; nextNumber: number; year: number; issued: number; categories: { id: string; name: string; code: string | null; effectiveCode: string }[] }

/** Asset ID format: saved separately from the other settings because it has its own rules and preview. */
function AssetIdFormatCard() {
  const toast = useToast();
  const { data, error, reload } = useApi<IdConfig>('/api/settings/asset-id');
  const [f, setF] = useState<AssetIdFormat>(DEFAULT_ASSET_ID_FORMAT);
  const [next, setNext] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const patternRef = useRef<HTMLInputElement>(null);
  // Where to put the caret back once an inserted token has rendered.
  const restoreCaret = useRef<number | null>(null);
  useEffect(() => { if (data) { setF(data.format); setNext(String(data.nextNumber)); } }, [data]);
  useLayoutEffect(() => {
    const el = patternRef.current, at = restoreCaret.current;
    if (el && at !== null) { el.focus(); el.setSelectionRange(at, at); restoreCaret.current = null; }
  }, [f.pattern]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Card title="Asset ID format"><Spinner /></Card>;

  const problems = validateAssetIdFormat(f);
  const problem = (k: string) => problems.find((p) => p.field === k)?.message;
  const nextN = Number(next);
  const nextErr = !Number.isInteger(nextN) || nextN < data.nextNumber ? `At least ${data.nextNumber}; numbers already issued are never reused.` : null;
  const seq = nextErr ? data.nextNumber : nextN;
  const sample = (cat: string, add = 0) => formatAssetId(f, { seq: seq + add, cat, year: data.year });
  const usesCat = f.pattern.includes('{CAT}');
  const cats = data.categories;
  const withoutCode = cats.filter((c) => !c.code);
  const dirty = JSON.stringify(f) !== JSON.stringify(data.format) || nextN !== data.nextNumber;
  const insert = (token: string) => {
    // The field keeps its selection after losing focus to the button, so insert at the caret.
    const el = patternRef.current;
    const at = el?.selectionStart ?? f.pattern.length, end = el?.selectionEnd ?? at;
    restoreCaret.current = at + token.length;
    setF({ ...f, pattern: f.pattern.slice(0, at) + token + f.pattern.slice(end) });
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/api/settings/asset-id', { method: 'PUT', body: { ...f, ...(nextN !== data.nextNumber ? { nextNumber: nextN } : {}) } });
      toast('Asset ID format saved. New assets use it from now on.'); reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Card title="Asset ID format" actions={<>
      {dirty && <button className="btn btn-sm" onClick={() => { setF(data.format); setNext(String(data.nextNumber)); setErr(null); }}>Discard</button>}
      <button className="btn btn-sm btn-primary" disabled={busy || !dirty || problems.length > 0 || !!nextErr} onClick={save}>{busy && <Spinner className="h-3 w-3" />}Save format</button>
    </>}>
      <p className="mb-3 text-sm text-slate-600">The system issues the Asset ID when an asset is registered, bulk-added, imported or created from an integration. It is printed on the QR label and never changes. A new format applies to new assets only; the {data.issued.toLocaleString('en-IN')} existing Asset IDs and their labels stay as they are.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Prefix" error={problem('prefix')} hint="Replaces {PREFIX}, e.g. IT or your company initials.">
          <input className="input font-mono uppercase" value={f.prefix} maxLength={8} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
        </Field>
        <Field label="Number digits" error={problem('padding')} hint="{SEQ} is zero-padded to this width.">
          <input className="input" type="number" min={3} max={9} value={f.padding} onChange={(e) => setF({ ...f, padding: Number(e.target.value) })} />
        </Field>
        <Field label="Next number" error={nextErr} hint="Can be moved forward, never back.">
          <input className="input" type="number" min={data.nextNumber} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
      <Field label="Pattern" className="mt-3" error={problem('pattern')} hint={<>Click a part to insert it. {'{SEQ}'} is required; separators can be - _ / or .</>}>
        <input ref={patternRef} className="input font-mono" value={f.pattern} maxLength={40} onChange={(e) => setF({ ...f, pattern: e.target.value })} />
      </Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ASSET_ID_TOKENS.map((t) => <button key={t.token} type="button" className="btn btn-sm" onClick={() => insert(t.token)} title={t.label}><span className="font-mono">{t.token}</span><span className="text-slate-500">{t.label}</span></button>)}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF(DEFAULT_ASSET_ID_FORMAT)}>Use default (AST-000001)</button>
      </div>
      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-medium text-slate-500">Next Asset ID</div>
        <div className="mt-0.5 break-all font-mono text-lg font-semibold">{problems.length ? '—' : sample(cats[0]?.effectiveCode ?? 'LAP')}</div>
        {!problems.length && usesCat && cats.length > 1 && (
          <ul className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-2">
            {cats.slice(0, 6).map((c, i) => <li key={c.id}>{c.name}: <span className="font-mono">{sample(c.effectiveCode, i)}</span></li>)}
          </ul>
        )}
        {!problems.length && !usesCat && <div className="mt-1 text-xs text-slate-500">Then <span className="font-mono">{sample('', 1)}</span>, <span className="font-mono">{sample('', 2)}</span>, …</div>}
      </div>
      {usesCat && withoutCode.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">{withoutCode.length} categor{withoutCode.length === 1 ? 'y has' : 'ies have'} no code, so the first letters of the name are used ({withoutCode.slice(0, 3).map((c) => `${c.name} → ${c.effectiveCode}`).join(', ')}{withoutCode.length > 3 ? ', …' : ''}). Set codes under <Link href="/admin/master-data">Categories &amp; departments</Link>.</p>
      )}
      <ErrorBox error={err} className="mt-3" />
    </Card>
  );
}
