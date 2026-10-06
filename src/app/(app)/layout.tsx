import { redirect } from 'next/navigation';
import { currentActor } from '@/server/http';
import { getSettings } from '@/server/settings';
import { listOrganizations } from '@/server/org';
import { MeProvider } from '@/components/me';
import { Shell } from '@/components/shell';
import { ToastProvider } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor) redirect('/login?expired=1');
  const s = await getSettings();
  // The organization list is read once here, with the actor, so no screen has to fetch it again.
  const orgs = (await listOrganizations()).filter((o) => o.active || o.id === actor.orgId);
  const canSwitch = actor.role !== 'BRANCH_USER';
  const me = {
    id: actor.id, name: actor.name, email: actor.email, role: actor.role,
    scopeName: actor.scopeName ?? null, locationId: actor.locationId ?? null, orgName: s.orgName,
    organization: actor.orgId ? { id: actor.orgId, name: actor.orgName ?? '' } : null,
    organizations: (canSwitch ? orgs : orgs.filter((o) => o.id === actor.orgId)).map((o) => ({ id: o.id, name: o.name })),
    canSwitchOrganization: canSwitch,
  };
  return (
    <MeProvider me={me}>
      <ToastProvider>
        <Shell>{children}</Shell>
      </ToastProvider>
    </MeProvider>
  );
}
