'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, ApiError, useApi } from '@/components/api';
import { countsText, FIELD_LABEL, RULE_LABEL, RunStatus, type RunCounts } from '@/components/integration-bits';
import { useMe } from '@/components/me';
import { CategorySelect, LocationSelect } from '@/components/pickers';
import { Badge, Card, ErrorBox, Field, Modal, PageHeader, Spinner, useConfirm, useToast } from '@/components/ui';

interface Source {
  id: string; key: string; name: string; kind: 'DEVICE' | 'DIRECTORY'; active: boolean; rateLimitPerMinute: number; autoCreate: boolean; autoCreateCategoryId: string | null; autoCreateLocationId: string | null;
  secondaryMatchKey: string; pullEnabled: boolean; pullIntervalMinutes: number | null; config: Record<string, unknown>; hasApiKey: boolean; apiKeyPrefix: string | null; apiKeyRevokedAt: string | null; hasSecret: boolean;
  lastSuccessAt: string | null; mappings: { field: string; rule: string }[];
}
interface Run extends RunCounts { id: string; mode: string; status: string; startedAt: string }

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2));

export default function SourcePage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const { data: s, error, reload } = useApi<Source>(`/api/integrations/sources/${id}`);
  const runs = useApi<{ rows: Run[] }>(`/api/integrations/runs?sourceId=${id}&pageSize=10`);
  const [f, setF] = useState<Source | null>(null);
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => {
    if (!s) return;
    setF(s);
    const c = s.config ?? {};
    setCfg(s.kind === 'DEVICE'
      ? { url: str(c.url), recordsPath: str(c.recordsPath), authHeader: str(c.authHeader), authScheme: str(c.authScheme), fieldMap: c.fieldMap ? str(c.fieldMap) : '' }
      : { url: str(c.url), bindDN: str(c.bindDN), baseDN: str(c.baseDN), filter: str(c.filter), attributes: c.attributes ? str(c.attributes) : '', tlsRejectUnauthorized: c.tlsRejectUnauthorized === false ? 'false' : 'true' });
    setSecret(undefined);
  }, [s]);
  if (error) return <ErrorBox error={error} />;
  if (!s || !f) return <div className="flex justify-center py-20"><Spinner /></div>;
  const admin = me.isAdmin;
  const endpoint = `${origin}/api/integrations/${s.key}/devices`;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const json = (k: string) => { if (!cfg[k]?.trim()) return undefined; try { return JSON.parse(cfg[k]); } catch { throw new ApiError(400, 'VALIDATION', `${k === 'fieldMap' ? 'Field map' : 'Attributes'} must be valid JSON.`); } };
      const config = s.kind === 'DEVICE'
        ? { url: cfg.url || undefined, recordsPath: cfg.recordsPath || undefined, authHeader: cfg.authHeader || undefined, authScheme: cfg.authScheme || undefined, fieldMap: json('fieldMap') }
        : { url: cfg.url || undefined, bindDN: cfg.bindDN || undefined, baseDN: cfg.baseDN || undefined, filter: cfg.filter || undefined, attributes: json('attributes'), tlsRejectUnauthorized: cfg.tlsRejectUnauthorized !== 'false' };
      await api(`/api/integrations/sources/${id}`, { method: 'PUT', body: {
        key: f.key, name: f.name, kind: f.kind, active: f.active, rateLimitPerMinute: f.rateLimitPerMinute, autoCreate: f.autoCreate, autoCreateCategoryId: f.autoCreateCategoryId, autoCreateLocationId: f.autoCreateLocationId,
        secondaryMatchKey: f.secondaryMatchKey, pullEnabled: f.pullEnabled, pullIntervalMinutes: f.pullIntervalMinutes, config: JSON.parse(JSON.stringify(config)), secret, mappings: f.mappings,
      } });
      toast('Saved'); reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const run = async (path: 'pull' | 'sync') => {
    setBusy(true);
    try { const r = await api<{ runId: string; status: string }>(`/api/integrations/sources/${id}/${path}`, { method: 'POST' }); toast(`Run finished: ${r.status.toLowerCase()}`); reload(); runs.reload(); }
    catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const issue = async () => {
    if (s.hasApiKey && !(await confirm('Issue a new key? The current key stops working immediately.'))) return;
    try { const r = await api<{ apiKey: string }>(`/api/integrations/sources/${id}/api-key`, { method: 'POST' }); setNewKey(r.apiKey); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const revoke = async () => {
    if (!(await confirm('Revoke the API key? The source will be rejected until a new key is issued.'))) return;
    try { await api(`/api/integrations/sources/${id}/api-key`, { method: 'DELETE' }); toast('Key revoked'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const set = (patch: Partial<Source>) => setF({ ...f, ...patch });
  const c = (k: string) => ({ value: cfg[k] ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setCfg({ ...cfg, [k]: e.target.value }), disabled: !admin });

  return (
    <div className="space-y-4">
      {node}
      <PageHeader back={{ href: '/integrations', label: 'Integrations' }} title={s.name}
        subtitle={<span className="flex items-center gap-2">{s.key} <Badge tone="blue">{s.kind === 'DEVICE' ? 'Device feed' : 'Directory (AD)'}</Badge>{!s.active && <Badge>Inactive</Badge>}</span>}
        actions={<>
          {s.kind === 'DEVICE' && <button className="btn" disabled={busy} onClick={() => run('pull')}>Pull now</button>}
          {s.kind === 'DIRECTORY' && <button className="btn" disabled={busy} onClick={() => run('sync')}>Sync now</button>}
        </>} />

      {s.kind === 'DEVICE' && (
        <Card title="Push endpoint and API key">
          <div className="space-y-2 text-sm">
            <div><code className="break-all rounded bg-slate-100 px-1">POST {endpoint}</code></div>
            <div>Header <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;api key&gt;</code>. Body <code className="rounded bg-slate-100 px-1">{'{"batchId": "…", "records": [{"serialNumber": "…", "hostname": "…", …}]}'}</code>, up to 5,000 records. Re-sending a batch ID is recognised and not applied twice.</div>
            <div className="flex flex-wrap items-center gap-2">
              Key: {s.hasApiKey ? <Badge tone="green">Active (itam_{s.apiKeyPrefix}_…)</Badge> : s.apiKeyRevokedAt ? <Badge tone="red">Revoked {fmtDateTime(s.apiKeyRevokedAt)}</Badge> : <Badge>Not issued</Badge>}
              {admin && <button className="btn btn-sm" onClick={issue}>{s.hasApiKey ? 'Rotate key' : 'Issue key'}</button>}
              {admin && s.hasApiKey && <button className="btn btn-sm btn-ghost text-red-600" onClick={revoke}>Revoke</button>}
            </div>
            <p className="text-xs text-slate-500">Only a hash of the key is stored; the key itself is shown once when issued. Limited to {s.rateLimitPerMinute} requests per minute.</p>
          </div>
        </Card>
      )}

      <Card title="Configuration">
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Name"><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} disabled={!admin} /></Field>
            <Field label="Status"><select className="input" value={String(f.active)} onChange={(e) => set({ active: e.target.value === 'true' })} disabled={!admin}><option value="true">Active</option><option value="false">Inactive (rejects pushes, skips schedules)</option></select></Field>
            {s.kind === 'DEVICE' && <Field label="Rate limit (requests / minute)"><input className="input" type="number" min={1} value={f.rateLimitPerMinute} onChange={(e) => set({ rateLimitPerMinute: Number(e.target.value) })} disabled={!admin} /></Field>}
          </div>
          {s.kind === 'DEVICE' && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Match by" hint="Records always match on serial number first"><select className="input" value={f.secondaryMatchKey} onChange={(e) => set({ secondaryMatchKey: e.target.value })} disabled={!admin}>
                  <option value="none">Serial number only</option><option value="hostname">Serial, then hostname</option><option value="mac">Serial, then MAC address</option><option value="legacyTag">Serial, then legacy tag</option></select></Field>
                <Field label="Unmatched records"><select className="input" value={String(f.autoCreate)} onChange={(e) => set({ autoCreate: e.target.value === 'true' })} disabled={!admin}><option value="false">Queue for review</option><option value="true">Create an asset automatically</option></select></Field>
              </div>
              {f.autoCreate && <div className="grid gap-3 md:grid-cols-2">
                <Field label="Category for new assets" required><CategorySelect value={f.autoCreateCategoryId ?? ''} onChange={(v) => set({ autoCreateCategoryId: v || null })} /></Field>
                <Field label="Location for new assets" required><LocationSelect value={f.autoCreateLocationId ?? ''} onChange={(v) => set({ autoCreateLocationId: v || null })} /></Field>
              </div>}
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={f.pullEnabled} onChange={(e) => set({ pullEnabled: e.target.checked })} disabled={!admin} />Pull from this source on a schedule</div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="URL"><input className="input" placeholder="https://mdm.example.com/api/devices" {...c('url')} /></Field>
                  <Field label="Records path in the response" hint="e.g. data.items; blank if the response is the array"><input className="input" {...c('recordsPath')} /></Field>
                  <Field label="Interval (minutes, min 15)"><input className="input" type="number" min={15} value={f.pullIntervalMinutes ?? ''} onChange={(e) => set({ pullIntervalMinutes: e.target.value ? Number(e.target.value) : null })} disabled={!admin} /></Field>
                  <Field label="Auth header" hint="Default Authorization"><input className="input" {...c('authHeader')} /></Field>
                  <Field label="Auth scheme" hint="Default Bearer"><input className="input" {...c('authScheme')} /></Field>
                  <Field label="Token" hint={s.hasSecret ? 'A token is stored (encrypted). Type to replace.' : 'Stored encrypted'}><input className="input" type="password" autoComplete="new-password" value={secret ?? ''} onChange={(e) => setSecret(e.target.value)} disabled={!admin} placeholder={s.hasSecret ? '••••••••' : ''} /></Field>
                </div>
                <Field label="Field map (JSON, optional)" hint='Source field (dots for nesting) to our field, e.g. {"serial": "serialNumber", "device.name": "hostname"}' className="mt-3"><textarea className="input font-mono text-xs" rows={3} {...c('fieldMap')} /></Field>
              </div>
            </>
          )}
          {s.kind === 'DIRECTORY' && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Directory URL"><input className="input" placeholder="ldaps://dc01.example.com:636" {...c('url')} /></Field>
              <Field label="Base DN"><input className="input" placeholder="OU=Staff,DC=example,DC=com" {...c('baseDN')} /></Field>
              <Field label="Bind DN"><input className="input" {...c('bindDN')} /></Field>
              <Field label="Bind password" hint={s.hasSecret ? 'A password is stored (encrypted). Type to replace.' : 'Stored encrypted'}><input className="input" type="password" autoComplete="new-password" value={secret ?? ''} onChange={(e) => setSecret(e.target.value)} disabled={!admin} placeholder={s.hasSecret ? '••••••••' : ''} /></Field>
              <Field label="Filter" hint="Default (&(objectCategory=person)(objectClass=user))"><input className="input" {...c('filter')} /></Field>
              <Field label="Verify TLS certificate"><select className="input" {...c('tlsRejectUnauthorized')}><option value="true">Yes</option><option value="false">No (test directories only)</option></select></Field>
              <Field label="Attribute map (JSON, optional)" hint='Defaults: employeeCode→employeeID, name→displayName, email→mail, department→department, manager→manager' className="md:col-span-2"><textarea className="input font-mono text-xs" rows={3} {...c('attributes')} /></Field>
              <div className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={f.pullEnabled} onChange={(e) => set({ pullEnabled: e.target.checked })} disabled={!admin} />Sync on a schedule every <input className="input w-24" type="number" min={15} value={f.pullIntervalMinutes ?? ''} onChange={(e) => set({ pullIntervalMinutes: e.target.value ? Number(e.target.value) : null })} disabled={!admin} /> minutes</div>
            </div>
          )}
          <div>
            <div className="field-label">When the source disagrees with a value in the register</div>
            <div className="table-wrap"><table className="tbl"><tbody>
              {f.mappings.map((m) => (
                <tr key={m.field}><td className="w-48">{FIELD_LABEL[m.field] ?? m.field}</td><td>
                  <select className="input" value={m.rule} disabled={!admin} onChange={(e) => set({ mappings: f.mappings.map((x) => (x.field === m.field ? { ...x, rule: e.target.value } : x)) })}>
                    {Object.entries(RULE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select></td></tr>
              ))}
            </tbody></table></div>
            <p className="mt-1 text-xs text-slate-500">Empty fields are always filled from the source. Values someone edited by hand are never overwritten unless the rule says the source wins.</p>
          </div>
          <ErrorBox error={err} />
          {admin && <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner className="h-3 w-3" />}Save configuration</button>}
        </div>
      </Card>

      <Card title="Recent runs" actions={<Link href={`/integrations?tab=runs&sourceId=${id}`} className="text-sm">All runs</Link>}>
        {!runs.data?.rows.length ? <p className="text-sm text-slate-500">No runs yet.</p> : (
          <div className="table-wrap"><table className="tbl"><tbody>
            {runs.data.rows.map((r) => <tr key={r.id}><td className="whitespace-nowrap"><Link href={`/integrations/runs/${r.id}`}>{fmtDateTime(r.startedAt)}</Link></td><td>{r.mode.toLowerCase()}</td><td><RunStatus s={r.status} /></td><td className="text-xs">{countsText(r)}</td></tr>)}
          </tbody></table></div>
        )}
      </Card>

      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="New API key" footer={<button className="btn btn-primary" onClick={() => setNewKey(null)}>I have stored it</button>}>
        <p className="text-sm">Copy this key now. It will not be shown again.</p>
        <div className="mt-2 flex gap-2"><code className="flex-1 break-all rounded bg-slate-100 p-2 text-xs">{newKey}</code>
          <button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(newKey ?? ''); toast('Copied'); }}>Copy</button></div>
      </Modal>
    </div>
  );
}
