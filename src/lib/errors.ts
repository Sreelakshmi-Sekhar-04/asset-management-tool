import { Prisma } from '@prisma/client';

export type ErrorDetail = { field?: string; line?: string | number; message: string; ref?: string };

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ErrorDetail[] | Record<string, unknown>,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: AppError['details']) => new AppError(400, 'VALIDATION_ERROR', msg, details);
export const unauthorized = (msg = 'Please sign in.') => new AppError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', msg);
/** Used for out-of-scope records too, so that nothing about the record is disclosed. */
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found or not accessible.`);
export const conflict = (msg: string, details?: AppError['details']) => new AppError(409, 'CONFLICT', msg, details);

/** The code is newer than the database: a migration has not been applied after an update. */
const dbNotMigrated = () =>
  new AppError(503, 'DB_NOT_MIGRATED', 'The database is not up to date with this version of the app. Ask your administrator to run "npm run db:migrate", then reload the page.');

/** The database is newer than the generated Prisma client: `prisma generate` did not run after an update. */
const clientOutOfDate = () =>
  new AppError(503, 'CLIENT_OUT_OF_DATE', 'The application was updated but its database client was not regenerated. Stop the server, run "npx prisma generate", then start it again.');

/** Translate database-level failures into specific, user-readable errors. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') {
      const target = String((e.meta?.target as string[] | string | undefined) ?? '');
      if (target.includes('assetCode')) return conflict('That Asset ID is already taken. Save again to get the next free Asset ID.');
      if (target.includes('serialNormalized')) return conflict('An asset with this serial number already exists.');
      if (target.includes('legacyTag')) return conflict('An asset with this legacy tag already exists.');
      if (target.includes('assetId')) return conflict('One or more assets are already part of an open transfer.');
      if (target.includes('email')) return conflict('This email address is already in use.');
      if (target.includes('employeeCode')) return conflict('An employee with this employee ID already exists.');
      if (target.includes('name')) return conflict('A record with this name already exists.');
      return conflict(`Duplicate value (${target}).`);
    }
    if (e.code === 'P2025') return notFound();
    if (e.code === 'P2003') return badRequest('A referenced record does not exist.');
    if (e.code === 'P2034') return conflict('Another user changed this record at the same moment. Please retry.');
    if (e.code === 'P2021' || e.code === 'P2022') return dbNotMigrated();
  }
  const msg = e instanceof Error ? e.message : String(e);
  // A stale client rejects new enum values and fields before the query reaches the database.
  if (e instanceof Prisma.PrismaClientValidationError && /Expected [A-Z]\w+\b|Unknown (argument|field)/.test(msg)) return clientOutOfDate();
  // A new enum value that the database does not have yet (its migration has not run).
  if (/invalid input value for enum|\b22P02\b.*enum/.test(msg)) return dbNotMigrated();
  // Raw queries report a missing table or column as Postgres 42P01 / 42703 (or 42883 for a missing function).
  if (/\b(42P01|42703|42883)\b|relation "[^"]+" does not exist/.test(msg)) return dbNotMigrated();
  const m = msg.match(/(ASSET_ID_IMMUTABLE|ASSET_ID_EXHAUSTED|ASSET_RETIRED|TRANSFER_NO_IMMUTABLE|AUDIT_APPEND_ONLY|DELETE_FORBIDDEN)[^\n"]*/);
  if (m) return new AppError(m[1] === 'AUDIT_APPEND_ONLY' || m[1] === 'DELETE_FORBIDDEN' ? 403 : 400, m[1], m[0].replace(/^[A-Z_]+: /, ''));
  if (/inv1_assigned_has_holder|inv2_holder|inv3_retired|holder_reference/.test(msg))
    return badRequest('The change violates an asset invariant: an Assigned asset needs a holder, and only Assigned or Under-repair assets may have one.');
  if (/transfer_lines_one_open_per_asset/.test(msg)) return conflict('One or more assets are already part of an open transfer.');
  return new AppError(500, 'INTERNAL', 'An unexpected error occurred. The error has been logged.');
}
