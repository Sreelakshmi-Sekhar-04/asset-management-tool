'use client';
import { useRef, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { api, qs, useApi } from './api';
import { Badge, Card, ErrorBox, FormModal, Field, Spinner, useToast } from './ui';

interface Doc { id: string; fileName: string; mimeType: string; sizeBytes: number; originalSize: number; description: string | null; uploadedByName: string; createdAt: string; scanStatus: string; deletedAt: string | null; deleteReason: string | null }

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Attachments for any record (FR-DOC). Upload is validated and scanned server-side. */
export function DocumentsPanel({ entityType, entityId, canUpload = true, isAdmin = false, title = 'Documents' }: { entityType: string; entityId: string; canUpload?: boolean; isAdmin?: boolean; title?: string }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, loading, reload } = useApi<{ rows: Doc[] }>(`/api/documents${qs({ entityType, entityId, includeDeleted: showDeleted ? 'true' : undefined })}`, [showDeleted]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [del, setDel] = useState<Doc | null>(null);
  const [reason, setReason] = useState('');
  const [desc, setDesc] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = async (f: File) => {
    setBusy(true); setErr(null);
    const form = new FormData();
    form.set('file', f); form.set('entityType', entityType); form.set('entityId', entityId);
    if (desc) form.set('description', desc);
    try { await api('/api/documents', { form }); toast(`Uploaded ${f.name}`); setDesc(''); reload(); } catch (e) { setErr(e); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  return (
    <Card title={title} actions={isAdmin && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />Show deleted</label>}>
      {canUpload && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input className="input max-w-xs py-1 text-xs" placeholder="Description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <input ref={file} type="file" className="text-xs" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} disabled={busy} aria-label="Upload file" />
          {busy && <Spinner />}
        </div>
      )}
      <ErrorBox error={err} className="mb-2" />
      {loading && !data ? <Spinner /> : !data?.rows.length ? <p className="text-sm text-slate-500">No documents attached.</p> : (
        <ul className="divide-y text-sm">
          {data.rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <a href={`/api/documents/${d.id}/download${/^(image\/|application\/pdf)/.test(d.mimeType) ? '?inline=true' : ''}`} target="_blank" rel="noopener" className={d.deletedAt ? 'line-through' : ''}>{d.fileName}</a>
                <div className="text-xs text-slate-500">{kb(d.sizeBytes)}{d.originalSize > d.sizeBytes ? ` (compressed from ${kb(d.originalSize)})` : ''} · {d.uploadedByName} · {fmtDateTime(d.createdAt)}{d.description ? ` · ${d.description}` : ''}</div>
                {d.deletedAt && <div className="text-xs text-red-600">Deleted {fmtDateTime(d.deletedAt)}: {d.deleteReason}</div>}
              </div>
              <div className="flex items-center gap-2">
                {d.scanStatus !== 'CLEAN' && <Badge tone={d.scanStatus === 'SKIPPED' ? 'gray' : 'amber'} title="Virus scan status">{d.scanStatus === 'SKIPPED' ? 'Not scanned' : d.scanStatus}</Badge>}
                {isAdmin && !d.deletedAt && <button className="btn btn-sm" onClick={() => { setDel(d); setReason(''); }}>Delete</button>}
                {isAdmin && d.deletedAt && <button className="btn btn-sm" onClick={async () => { await api(`/api/documents/${d.id}/restore`, { method: 'POST' }); reload(); }}>Restore</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <FormModal open={!!del} onClose={() => setDel(null)} title={`Delete ${del?.fileName}`} submitLabel="Delete" danger
        onSubmit={async () => { await api(`/api/documents/${del!.id}`, { method: 'DELETE', body: { reason } }); toast('Document deleted'); reload(); }}>
        <p className="text-sm text-slate-600">The file is hidden and kept for the retention period, then purged. The deletion is audited.</p>
        <Field label="Reason" required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
      </FormModal>
    </Card>
  );
}
