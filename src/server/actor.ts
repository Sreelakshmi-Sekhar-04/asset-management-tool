import type { Role } from '@prisma/client';

/** The authenticated principal on whose behalf a service call runs. */
export interface Actor {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Branch users: the bound location node; scope includes its descendants (BR-CFG-1). */
  locationId: string | null;
  scopeIdPath: string | null;
  scopeName: string | null;
  employeeId: string | null;
  sessionId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** Used by the worker / scheduler for automated actions. */
export const SYSTEM_ACTOR: Actor = {
  id: 'system',
  name: 'System',
  email: 'system@localhost',
  role: 'ADMIN',
  locationId: null,
  scopeIdPath: null,
  scopeName: null,
  employeeId: null,
};

export const isAdmin = (a: Actor) => a.role === 'ADMIN';
export const isIT = (a: Actor) => a.role === 'ADMIN' || a.role === 'IT_OPERATOR';
export const isBranch = (a: Actor) => a.role === 'BRANCH_USER';
