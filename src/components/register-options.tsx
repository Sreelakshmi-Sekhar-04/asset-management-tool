'use client';
import Link from 'next/link';
import { Modal } from './ui';

/** Every way to put assets into the register. */
export const REGISTER_WAYS = [
  { href: '/assets/new', title: 'Manual form', when: 'Fill in the form by hand. Best for a single device or one with unusual details.' },
  { href: '/assets/scan-register', title: 'Scan to register', when: 'Scan the serial-number barcode on each device with a phone camera or a USB scanner; the rest of the details carry over to the next device.' },
  { href: '/assets/bulk-add', title: 'Bulk add', when: 'Many devices of one make and model. Enter the common details once, then scan or type a serial per row.' },
  { href: '/assets/bulk-add?tab=excel', title: 'Excel / CSV upload', when: 'An existing list or a supplier’s delivery sheet. A dry run shows every row before anything is saved.' },
  { href: '/integrations/unmatched', title: 'From discovery tools', when: 'Devices reported by a connected discovery or endpoint tool that are not in the register yet.' },
];

export function RegisterOptions({ onPick }: { onPick?: () => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {REGISTER_WAYS.map((w) => (
        <Link key={w.href} href={w.href} onClick={onPick} className="block rounded-md border p-3 text-inherit no-underline hover:border-slate-400 hover:bg-slate-50 hover:no-underline">
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
    <Modal open={open} onClose={onClose} title="Register asset" wide>
      <p className="mb-3 text-sm text-slate-600">Choose how to add. Every method assigns the Asset ID on save and runs the same duplicate checks.</p>
      <RegisterOptions onPick={onClose} />
    </Modal>
  );
}
