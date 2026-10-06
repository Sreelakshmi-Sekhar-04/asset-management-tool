'use client';
import { Suspense } from 'react';
import { ImportPanel } from '@/components/import-panel';
import { PageHeader } from '@/components/ui';

export default function ImportsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Import" subtitle="Upload a CSV or Excel file. A dry run shows exactly what will happen; nothing is saved until you confirm." />
      <Suspense><ImportPanel /></Suspense>
    </div>
  );
}
