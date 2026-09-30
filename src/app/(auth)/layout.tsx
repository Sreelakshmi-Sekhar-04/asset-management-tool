import { getSettings } from '@/server/settings';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const s = await getSettings();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">{s.orgName}</div>
          <div className="text-sm text-slate-500">IT Asset Management</div>
        </div>
        <div className="card card-body">{children}</div>
      </div>
    </div>
  );
}
