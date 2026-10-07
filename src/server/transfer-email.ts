import type { ApprovalRequest } from '@prisma/client';
import type { Db } from '@/lib/db';
import { fmtDateTime } from '@/lib/format';
import { appUrl } from './notify';

/**
 * The emails of a transfer's workflow: the request waiting for the admin manager (step 1), then
 * for the destination's location manager (step 2), and the approved transfer waiting for the
 * destination to confirm receipt. Each carries the transfer reference, the assets, both
 * locations, who asked and when, where the approval stands, and a link to the request.
 */
export type TransferMailStage = 'APPROVAL_1' | 'APPROVAL_2' | 'RECEIVE';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function transferMail(db: Db, req: Pick<ApprovalRequest, 'id' | 'requestNo' | 'payload' | 'initiatorName' | 'createdAt'>, stage: TransferMailStage, transferNo?: string) {
  const pl = req.payload as { assetIds?: string[]; toLocationId?: string; remarks?: string | null };
  const [assets, to, tasks] = await Promise.all([
    db.asset.findMany({ where: { id: { in: pl.assetIds ?? [] } }, orderBy: { assetCode: 'asc' }, select: { assetCode: true, make: true, model: true, serialNumber: true, location: { select: { namePath: true } } } }),
    pl.toLocationId ? db.location.findUnique({ where: { id: pl.toLocationId }, select: { namePath: true } }) : null,
    db.approvalTask.findMany({ where: { requestId: req.id }, orderBy: { stepOrder: 'asc' } }),
  ]);
  const from = [...new Set(assets.map((a) => a.location?.namePath ?? '—'))].join('; ');
  const dest = to?.namePath ?? '—';
  const destShort = dest.split(' / ').pop();
  const step1 = tasks.find((t) => t.stepOrder === 1 && t.status === 'APPROVED');
  const step2 = tasks.find((t) => t.stepOrder === 2 && t.status === 'APPROVED');
  const link = appUrl(`/approvals/${req.id}`);
  const n = assets.length;
  const what = `${n} asset${n === 1 ? '' : 's'} to ${destShort}`;

  const head = {
    APPROVAL_1: { subject: `Approval needed: transfer ${req.requestNo} (${what})`, intro: 'A transfer is waiting for your approval as the admin manager (step 1 of 2).', action: 'Approve or reject the transfer' },
    APPROVAL_2: { subject: `Approval needed: transfer ${req.requestNo} (${what})`, intro: `A transfer into ${destShort} is awaiting your approval as the destination location manager (step 2 of 2). The admin manager has approved it.`, action: 'Approve or reject the transfer' },
    RECEIVE: { subject: `Confirm receipt: transfer ${transferNo ?? req.requestNo} (${what})`, intro: `This transfer has both approvals and is on its way to ${destShort}. When the assets arrive, confirm what was actually received and its condition. The transfer is complete only after that.`, action: 'Confirm receipt' },
  }[stage];

  const approvalLine = (t: typeof step1, label: string) => t ? `${label}: Approved by ${t.decidedByName ?? '—'} on ${fmtDateTime(t.decidedAt)}${t.comment ? ` ("${t.comment}")` : ''}` : null;
  const facts: [string, string][] = [
    ['Transfer reference', transferNo ? `${transferNo} (request ${req.requestNo})` : req.requestNo],
    ['Requested by', req.initiatorName],
    ['Requested on', fmtDateTime(req.createdAt)],
    ['From (current location)', from],
    ['To (destination)', dest],
    ...(pl.remarks ? [['Remarks', pl.remarks] as [string, string]] : []),
  ];
  const status: string[] = [
    stage === 'APPROVAL_1' ? 'Admin manager approval: waiting for you' : approvalLine(step1, 'Admin manager approval') ?? 'Admin manager approval: —',
    stage === 'APPROVAL_1' ? 'Destination location manager approval: after yours' : stage === 'APPROVAL_2' ? 'Destination location manager approval: waiting for you' : approvalLine(step2, 'Destination location manager approval') ?? '—',
    ...(stage === 'RECEIVE' ? ['Receipt at destination: waiting for confirmation'] : []),
  ];

  const text = [
    head.intro, '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '',
    `Assets (${n}):`,
    ...assets.map((a) => `  ${a.assetCode}  ${a.make} ${a.model}  Serial: ${a.serialNumber ?? '—'}  At: ${a.location?.namePath ?? '—'}`), '',
    'Approval status:',
    ...status.map((s) => `  ${s}`), '',
    `${head.action}: ${link}`,
  ].join('\n');

  const td = 'padding:4px 10px;border:1px solid #e2e8f0;font-size:13px;vertical-align:top';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:680px">
<p style="font-size:14px">${esc(head.intro)}</p>
<table style="border-collapse:collapse;margin:8px 0">${facts.map(([k, v]) => `<tr><td style="${td};color:#475569">${esc(k)}</td><td style="${td}"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p style="font-size:13px;margin:12px 0 4px"><b>Assets (${n})</b></p>
<table style="border-collapse:collapse"><tr>${['Asset ID', 'Asset name', 'Serial number', 'Current location'].map((h) => `<th style="${td};background:#f1f5f9;text-align:left">${h}</th>`).join('')}</tr>
${assets.map((a) => `<tr><td style="${td}"><b>${esc(a.assetCode)}</b></td><td style="${td}">${esc(`${a.make} ${a.model}`)}</td><td style="${td}">${esc(a.serialNumber ?? '—')}</td><td style="${td}">${esc(a.location?.namePath ?? '—')}</td></tr>`).join('')}</table>
<p style="font-size:13px;margin:12px 0 4px"><b>Approval status</b></p>
<ul style="font-size:13px;margin:0;padding-left:18px">${status.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<p style="margin:18px 0"><a href="${esc(link)}" style="background:#4f46e5;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-size:14px">${esc(head.action)}</a></p>
<p style="font-size:12px;color:#64748b">Or open ${esc(link)}</p>
</div>`;
  return { subject: head.subject, text, html };
}
