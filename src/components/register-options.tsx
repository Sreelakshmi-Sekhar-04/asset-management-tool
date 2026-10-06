'use client';
import Link from 'next/link';
import { Modal } from './ui';

/** The two ways to add assets offered by "Register asset". */
export const REGISTER_WAYS = [
  { href: '/assets/new', title: 'Manual', when: 'Fill in the form by hand, one asset at a time.' },
  { href: '/assets/bulk-add?tab=excel', title: 'Excel Upload', when: 'Upload an Excel file of assets. A dry run shows every row before anything is saved.' },
];

export function RegisterOptions({ onPick }: { onPick?: () => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {REGISTER_WAYS.map((w) => (
        <Link key={w.href} href={w.href} onClick={onPick} className="block rounded-md border p-3 text-inherit no-underline hover:border-slate-400 hover:bg-slate-50 hover:no-underline focus-visible:border-slate-400 focus-visible:bg-slate-50">
          <span className="block text-sm font-semibold text-slate-900">{w.title}</span>
          <span className="mt-0.5 block text-xs text-slate-600">{w.when}</span>
        </Link>
      ))}
    </div>
  );
}

/** The chooser behind the Asset register's "Register asset" button. */
export function RegisterAssetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Register asset">
      <p className="mb-3 text-sm text-slate-600">Choose how to add. Both assign the Asset ID on save and run the same duplicate checks.</p>
      <RegisterOptions onPick={onClose} />
    </Modal>
  );
}
