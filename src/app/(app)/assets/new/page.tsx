'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { AssetFields, DuplicateNotice, emptyAsset, toPayload, type AssetFormValues } from '@/components/asset-form';
import { Card, PageHeader, Spinner, useToast } from '@/components/ui';

export default function NewAsset() {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<AssetFormValues>(emptyAsset);
  const [err, setErr] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Arriving from the scanner with an unregistered barcode: start with it as the serial number.
  useEffect(() => {
    const serial = new URLSearchParams(window.location.search).get('serial')?.trim();
    if (serial) setV((x) => ({ ...x, serialNumber: serial.slice(0, 120) }));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ asset?: { id: string; assetCode: string }; pendingApproval?: { id: string; requestNo: string; policy: string } }>('/api/assets', { body: { ...toPayload(v), duplicateReason: reason || null } });
      if (r.asset) { toast(`Registered ${r.asset.assetCode}`); router.push(`/assets/${r.asset.id}`); }
      else if (r.pendingApproval) { toast(`Sent for approval (${r.pendingApproval.requestNo}, ${r.pendingApproval.policy})`); router.push(`/approvals/${r.pendingApproval.id}`); }
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-4xl">
      <PageHeader title="Register asset" subtitle="The Asset ID is assigned by the system on save and never changes." back={{ href: '/assets', label: 'Asset register' }} />
      <form onSubmit={submit}>
        <Card>
          <AssetFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} mode="create" />
          <div className="mt-4 space-y-3">
            <DuplicateNotice error={err} reason={reason} setReason={setReason} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => router.back()}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Save asset</button>
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}
