'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/components/api';
import { AssetFields, DuplicateNotice, emptyAsset, toPayload, type AssetFormValues } from '@/components/asset-form';
import { ImportPanel } from '@/components/import-panel';
import { Card, PageHeader, Spinner, Tabs, useToast } from '@/components/ui';

const TABS = [
  { key: 'manual', label: 'Manual', subtitle: 'Fill in the form by hand, one asset at a time. The Asset ID is assigned by the system on save and never changes.' },
  { key: 'excel', label: 'Excel Upload', subtitle: 'Upload an Excel file of assets. A dry run shows every row, in the asset register’s columns, before anything is saved.' },
];

/** Create asset: the manual form or an Excel upload, switched by tabs on the same page. */
function CreateAsset() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = sp.get('tab') === 'excel' ? 'excel' : 'manual';
  const t = TABS.find((x) => x.key === tab)!;
  return (
    <div className="max-w-5xl">
      <PageHeader title="Create asset" subtitle={t.subtitle} back={{ href: '/assets', label: 'Asset register' }} />
      <Tabs tabs={TABS} value={tab} onChange={(k) => router.replace(k === 'manual' ? pathname : `${pathname}?tab=${k}`, { scroll: false })} />
      {tab === 'excel' ? <ImportPanel assetsOnly /> : <ManualForm />}
    </div>
  );
}

export default function NewAsset() { return <Suspense><CreateAsset /></Suspense>; }

function ManualForm() {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState<AssetFormValues>(emptyAsset);
  const [err, setErr] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ asset?: { id: string; assetCode: string }; pendingApproval?: { id: string; requestNo: string; policy: string } }>('/api/assets', { body: { ...toPayload(v), duplicateReason: reason || null } });
      if (r.asset) { toast(`Registered ${r.asset.assetCode}`); router.push(`/assets/${r.asset.id}?registered=1`); }
      else if (r.pendingApproval) { toast(`Sent for approval (${r.pendingApproval.requestNo}, ${r.pendingApproval.policy})`); router.push(`/approvals/${r.pendingApproval.id}`); }
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="max-w-4xl">
      <Card>
        <AssetFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} mode="create" />
        <div className="mt-4 space-y-3">
          <DuplicateNotice error={err} reason={reason} setReason={setReason} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => router.push('/assets')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{busy && <Spinner className="h-3 w-3" />}Create asset</button>
          </div>
        </div>
      </Card>
    </form>
  );
}
