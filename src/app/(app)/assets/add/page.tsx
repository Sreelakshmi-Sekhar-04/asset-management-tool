import Link from 'next/link';
import { PageHeader } from '@/components/ui';

const WAYS = [
  { href: '/assets/new', title: 'Register one asset', when: 'Fill in the form by hand. Best for a single device or one with unusual details.' },
  { href: '/assets/scan-register', title: 'Scan to register', when: 'Scan the serial-number barcode on each device with a phone camera or a USB scanner; the rest of the details carry over to the next device.' },
  { href: '/assets/bulk-add', title: 'Bulk add / Import', when: 'Many devices at once. Scan or type a serial per row for one make and model, or upload an Excel or CSV list and review a dry run, row by row, before anything is saved.' },
  { href: '/integrations/unmatched', title: 'From discovery tools', when: 'Devices reported by a connected discovery or endpoint tool that are not in the register yet. Create an asset from each one, or link it to an existing asset.' },
];

/** Every way to put assets into the register, so users can pick the one that fits. */
export default function WaysToRegister() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Ways to register assets" subtitle="Every method assigns the Asset ID on save and runs the same duplicate checks." back={{ href: '/assets', label: 'Asset register' }} />
      <div className="grid gap-3 sm:grid-cols-2">
        {WAYS.map((w) => (
          <Link key={w.href} href={w.href} className="card card-body block text-inherit no-underline hover:border-slate-400">
            <h2 className="text-base font-semibold">{w.title}</h2>
            <p className="mt-1 text-sm text-slate-600">{w.when}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
