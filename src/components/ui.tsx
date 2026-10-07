'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export { clsx };

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600', className)} role="status" aria-label="Loading" />;
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && <Link href={back.href} className="text-xs text-slate-500">← {back.label}</Link>}
        <h1 className="truncate">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm">{title}</h2>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={clsx('card-body', bodyClass)}>{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  gray: 'bg-slate-100 text-slate-700', blue: 'bg-blue-100 text-blue-800', green: 'bg-green-100 text-green-800', amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800', purple: 'bg-purple-100 text-purple-800', teal: 'bg-teal-100 text-teal-800',
};
export function Badge({ tone = 'gray', children, title }: { tone?: keyof typeof TONES | string; children: ReactNode; title?: string }) {
  return <span title={title} className={clsx('badge', TONES[tone] ?? TONES.gray)}>{children}</span>;
}

export function Field({ label, error, hint, children, required, className }: { label: string; error?: string | null; hint?: ReactNode; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="field-label">{label}{required && <span className="text-red-600"> *</span>}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const msg = e?.message ?? (error instanceof Error ? error.message : String(error));
  const list = e?.list ?? [];
  return (
    <div role="alert" className={clsx('rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800', className)}>
      <div className="font-medium">{msg}</div>
      {list.length > 0 && (
        <ul className="mt-1 max-h-48 list-disc overflow-auto pl-5 text-xs">
          {list.slice(0, 200).map((d, i) => <li key={i}>{d.line ?? d.ref ?? d.field ? <b>{String(d.line ?? d.ref ?? d.field)}: </b> : null}{d.message}</li>)}
          {list.length > 200 && <li>… and {list.length - 200} more</li>}
        </ul>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-slate-500">{children}</div>;
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline onClose functions, so keep the latest in a ref: the effect below must run only when
  // the dialog opens, otherwise every re-render (each keystroke in a field) steals focus back.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    const root = ref.current;
    (root?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea') ?? root?.querySelector<HTMLElement>('button'))?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" className={clsx('flex max-h-[92vh] w-full flex-col rounded-t-lg bg-white shadow-xl sm:rounded-lg', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** A form dialog: runs onSubmit, shows server errors inline, closes on success. */
export function FormModal({ open, onClose, title, submitLabel = 'Save', danger, onSubmit, children, wide, disabled }: {
  open: boolean; onClose: () => void; title: ReactNode; submitLabel?: string; danger?: boolean; wide?: boolean; disabled?: boolean;
  onSubmit: () => Promise<unknown>; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const id = useId();
  useEffect(() => { if (open) setErr(null); }, [open]);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try { await onSubmit(); onClose(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} wide={wide}
      footer={<><button className="btn" type="button" onClick={onClose}>Cancel</button><button form={id} className={clsx('btn', danger ? 'btn-danger' : 'btn-primary')} disabled={busy || disabled}>{busy && <Spinner className="h-3 w-3" />}{submitLabel}</button></>}>
      <form id={id} onSubmit={submit} className="space-y-3">
        {children}
        <ErrorBox error={err} />
      </form>
    </Modal>
  );
}

// ── Toasts ──
type Toast = { id: number; text: string; tone: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'err') => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'err' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,24rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto rounded-md px-3 py-2 text-sm shadow-lg', t.tone === 'ok' ? 'bg-slate-900 text-white' : 'bg-red-600 text-white')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm', value === t.key ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, href, tone, hint }: { label: string; value: ReactNode; href?: string; tone?: 'red' | 'amber' | 'green'; hint?: string }) {
  const inner = (
    <div className="card card-body h-full">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold', tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-green-700' : 'text-slate-900')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? <Link href={href} className="block no-underline hover:no-underline hover:opacity-90">{inner}</Link> : inner;
}

export function useConfirm() {
  const [state, setState] = useState<{ text: ReactNode; resolve: (v: boolean) => void; title?: ReactNode; okLabel?: string; danger?: boolean } | null>(null);
  /** Asks for confirmation; `opts` can name the dialog and its button (e.g. "Remove"). */
  const confirm = (text: ReactNode, opts: { title?: ReactNode; okLabel?: string; danger?: boolean } = {}) => new Promise<boolean>((resolve) => setState({ text, resolve, ...opts }));
  const node = (
    <Modal open={!!state} onClose={() => { state?.resolve(false); setState(null); }} title={state?.title ?? 'Please confirm'}
      footer={<><button className="btn" onClick={() => { state?.resolve(false); setState(null); }}>Cancel</button><button className={clsx('btn', state?.danger ? 'btn-danger' : 'btn-primary')} onClick={() => { state?.resolve(true); setState(null); }}>{state?.okLabel ?? 'Confirm'}</button></>}>
      <div className="text-sm">{state?.text}</div>
    </Modal>
  );
  return { confirm, node };
}
