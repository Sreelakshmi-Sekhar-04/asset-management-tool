'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { HISTORIC_ACTION_LABEL, label } from '@/lib/labels';
import { api, useApi } from '@/components/api';
import { ApprovalChain, pendingStage, type ApprovalReq } from '@/components/approval-chain';
import { useMe } from '@/components/me';
import { UserSelect } from '@/components/pickers';
import { EmailDeliveries, TransferShipments } from '@/components/transfer-receipt';
import { Badge, Card, ErrorBox, Field, FormModal, PageHeader, Spinner, useToast } from '@/components/ui';

type Req = ApprovalReq & {
  canAct: boolean; canCancel: boolean; entityType: string | null; entityId: string | null; assetIds: string[]; payload: Record<string, unknown>; initiatorRole: string;
  transfer: { to: string | null; assets: { id: string; assetCode: string; name: string; serialNumber: string | null; from: string | null }[] } | null;
};

export default function ApprovalDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const toast = useToast();
  const { data: r, error, reload } = useApi<Req>(`/api/approvals/${id}`);
  const [decision, setDecision] = useState<'' | 'APPROVE' | 'REJECT'>('');
  const [comment, setComment] = useState('');
  const [reassign, setReassign] = useState(false);
  const [toUser, setToUser] = useState('');
  if (error) return <ErrorBox error={error} />;
  if (!r) return <div className="flex justify-center py-20"><Spinner /></div>;
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader back={{ href: '/approvals', label: 'Approvals' }} title={<span className="flex items-center gap-2">{r.requestNo} <Badge tone={r.status === 'PENDING' ? 'amber' : r.status === 'APPROVED' ? 'green' : 'red'}>{pendingStage(r) && r.action === 'TRANSFER' ? pendingStage(r) : r.status.toLowerCase()}</Badge></span>}
        subtitle={`${label(HISTORIC_ACTION_LABEL, r.action)} · ${r.policyName}`}
        actions={<>
          {r.canAct && <><button className="btn btn-primary" onClick={() => { setDecision('APPROVE'); setComment(''); }}>Approve</button><button className="btn btn-danger" onClick={() => { setDecision('REJECT'); setComment(''); }}>Reject</button></>}
          {r.canCancel && <button className="btn" onClick={async () => { try { await api(`/api/approvals/${r.id}/cancel`, { method: 'POST' }); toast('Request withdrawn'); reload(); } catch (e) { toast((e as Error).message, 'err'); } }}>Withdraw</button>}
          {me.isAdmin && r.status === 'PENDING' && <button className="btn" onClick={() => setReassign(true)}>Reassign</button>}
        </>} />
      <Card title="Request">
        <dl className="kv">
          <dt>Summary</dt><dd>{r.summary}</dd>
          <dt>Raised by</dt><dd>{r.initiatorName} · {fmtDateTime(r.createdAt)}</dd>
          {r.transfer && <><dt>Destination</dt><dd>{r.transfer.to ?? '—'}</dd></>}
          {!r.transfer && r.assetIds.length > 0 && <><dt>Assets</dt><dd>{r.assetIds.length} asset(s){r.assetIds.length <= 20 && <> · {r.assetIds.map((a) => <Link key={a} href={`/assets/${a}`} className="mr-2">view</Link>)}</>}</dd></>}
          {r.decidedAt && <><dt>Decided</dt><dd>{fmtDateTime(r.decidedAt)}</dd></>}
          {r.failureReason && <><dt>Failed</dt><dd className="text-red-600">{r.failureReason}</dd></>}
        </dl>
      </Card>
      {r.transfer && (
        <Card title={`Assets (${r.transfer.assets.length})`} bodyClass="p-0">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Asset ID</th><th>Asset name</th><th>Serial no.</th><th>Current location</th><th>Destination</th></tr></thead>
              <tbody>{r.transfer.assets.map((a) => (
                <tr key={a.id}><td><Link href={`/assets/${a.id}`} className="font-semibold">{a.assetCode}</Link></td><td>{a.name}</td><td className="font-mono text-xs">{a.serialNumber ?? '—'}</td><td className="text-xs">{a.from ?? '—'}</td><td className="text-xs">{r.transfer!.to ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="Approval steps"><ApprovalChain req={r} /></Card>
      {r.action === 'TRANSFER' && r.status === 'APPROVED' && <TransferShipments requestId={r.id} onChanged={reload} />}
      <EmailDeliveries requestId={r.id} />
      <FormModal open={!!decision} onClose={() => setDecision('')} title={decision === 'APPROVE' ? 'Approve' : 'Reject'} submitLabel={decision === 'APPROVE' ? 'Approve' : 'Reject'} danger={decision === 'REJECT'}
        onSubmit={async () => { await api(`/api/approvals/${r.id}/decide`, { body: { decision, comment: comment || null } }); toast('Decision recorded'); reload(); }}>
        <Field label={decision === 'REJECT' ? 'Reason (required)' : 'Comment'} required={decision === 'REJECT'}><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} required={decision === 'REJECT'} /></Field>
      </FormModal>
      <FormModal open={reassign} onClose={() => setReassign(false)} title="Reassign current step" submitLabel="Reassign" disabled={!toUser}
        onSubmit={async () => { await api(`/api/approvals/${r.id}/reassign`, { body: { toUserId: toUser, comment: comment || undefined } }); toast('Reassigned'); reload(); }}>
        <Field label="New approver" required><UserSelect value={toUser} onChange={setToUser} roles={r.action === 'TRANSFER' && r.currentOrder > 1 ? ['ADMIN', 'IT_OPERATOR', 'BRANCH_USER'] : ['ADMIN', 'IT_OPERATOR']} /></Field>
        <Field label="Comment"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </FormModal>
    </div>
  );
}
