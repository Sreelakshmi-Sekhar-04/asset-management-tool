import type { Role } from '@prisma/client';
import { currentActor } from '@/server/http';

/**
 * Server-side page guard for role-restricted sections. The APIs behind these pages
 * enforce the same roles; this only avoids showing an empty screen.
 */
export async function RoleGate({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const actor = await currentActor();
  if (!actor || !roles.includes(actor.role)) {
    return (
      <div className="card card-body max-w-lg">
        <h1 className="text-lg font-semibold">Not available</h1>
        <p className="mt-1 text-sm text-slate-600">This area is limited to {roles.includes('IT_OPERATOR') ? 'IT operators and Administrators' : 'Administrators'}.</p>
      </div>
    );
  }
  return <>{children}</>;
}
