'use client';
import { useEffect, useState } from 'react';
import { ApiError, download } from './api';
import { ErrorBox, Modal, Spinner } from './ui';

const LAYOUTS = [
  { key: 'A4', name: 'A4 sheet', hint: '24 labels per page (3 × 8). For office laser or inkjet printers.' },
  { key: 'THERMAL_50x25', name: 'Thermal label 50 × 25 mm', hint: 'One label per page. For thermal label printers; set the paper size to 50 × 25 mm.' },
] as const;
type Layout = (typeof LAYOUTS)[number]['key'];
const PREF = 'itam:label-layout';

/**
 * Print QR asset labels (FR-REG-10) for one or more assets. "Open to print" shows the PDF in
 * a new tab, which doubles as the print preview; "Download PDF" saves it.
 */
export function LabelPrintDialog({ open, onClose, assetIds, title }: { open: boolean; onClose: () => void; assetIds: string[]; title?: string }) {
  const [layout, setLayout] = useState<Layout>('A4');
  const [busy, setBusy] = useState<'' | 'open' | 'download'>('');
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    try { const v = localStorage.getItem(PREF); if (LAYOUTS.some((l) => l.key === v)) setLayout(v as Layout); } catch { /* storage unavailable */ }
  }, [open]);
  const choose = (v: Layout) => { setLayout(v); try { localStorage.setItem(PREF, v); } catch { /* storage unavailable */ } };
  const body = { assetIds, layout };

  const openToPrint = async () => {
    // Open the tab inside the click so pop-up blockers allow it, then point it at the PDF.
    const win = window.open('', '_blank');
    setBusy('open'); setErr(null);
    try {
      const res = await fetch('/api/assets/labels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new ApiError(res.status, j?.error?.code ?? 'ERROR', j?.error?.message ?? 'The labels could not be generated. Please try again.');
      }
      const url = URL.createObjectURL(await res.blob());
      if (win) win.location.href = url;
      else { // pop-ups blocked: fall back to saving the file
        const a = document.createElement('a');
        a.href = url; a.download = 'asset-labels.pdf';
        document.body.appendChild(a); a.click(); a.remove();
      }
      onClose();
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      win?.close();
      setErr(e);
    } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('download'); setErr(null);
    try { await download('/api/assets/labels', body); onClose(); } catch (e) { setErr(e); } finally { setBusy(''); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title ?? `Print ${assetIds.length === 1 ? 'asset label' : `${assetIds.length} asset labels`}`}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={!!busy}>{busy === 'download' && <Spinner className="h-3 w-3" />}Download PDF</button>
        <button className="btn btn-primary" onClick={openToPrint} disabled={!!busy}>{busy === 'open' && <Spinner className="h-3 w-3" />}Open to print</button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Each label carries a QR code of the Asset ID, the Asset ID in text, the make and model, and the serial number. Scanning the QR opens the asset.</p>
        <fieldset className="space-y-2">
          <legend className="field-label">Label stock</legend>
          {LAYOUTS.map((l) => (
            <label key={l.key} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2.5 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
              <input type="radio" name="label-layout" className="mt-0.5" checked={layout === l.key} onChange={() => choose(l.key)} />
              <span><span className="font-medium">{l.name}</span><span className="block text-xs text-slate-500">{l.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-slate-500">When printing, set scaling to “Actual size” (100%) so the QR codes scan reliably.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
