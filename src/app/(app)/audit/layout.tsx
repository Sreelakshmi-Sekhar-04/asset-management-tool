import { RoleGate } from '@/components/role-gate';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RoleGate roles={['ADMIN', 'IT_OPERATOR']}>{children}</RoleGate>;
}
