'use client';
import { createContext, useContext } from 'react';

export interface Me {
  id: string; name: string; email: string; role: 'ADMIN' | 'IT_OPERATOR' | 'BRANCH_USER';
  scopeName: string | null; locationId: string | null;
  /** Organisation name from Settings (the branding in the sidebar). */
  orgName: string;
  /** The selected organization (head quarter) whose data every screen shows. */
  organization: { id: string; name: string } | null;
  organizations: { id: string; name: string }[];
  canSwitchOrganization: boolean;
}
const Ctx = createContext<Me | null>(null);
export const MeProvider = ({ me, children }: { me: Me; children: React.ReactNode }) => <Ctx.Provider value={me}>{children}</Ctx.Provider>;
export function useMe() {
  const m = useContext(Ctx);
  if (!m) throw new Error('useMe outside MeProvider');
  return { ...m, isAdmin: m.role === 'ADMIN', isIT: m.role === 'ADMIN' || m.role === 'IT_OPERATOR', isBranch: m.role === 'BRANCH_USER' };
}
