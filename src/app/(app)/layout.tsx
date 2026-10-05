import { redirect } from 'next/navigation';
import { currentActor } from '@/server/http';
import { getSettings } from '@/server/settings';
import { MeProvider } from '@/components/me';
import { Shell } from '@/components/shell';
import { ToastProvider } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?expired=1');
  const s = await getSettings();
  const me = { id: actor.id, name: actor.name, email: actor.email, role: actor.role, scopeName: actor.scopeName ?? null, locationId: actor.locationId ?? null, orgName: s.orgName };
  return (
    <MeProvider me={me}>
      <ToastProvider>
        <Shell>{children}</Shell>
      </ToastProvider>
    </MeProvider>
  );
}
