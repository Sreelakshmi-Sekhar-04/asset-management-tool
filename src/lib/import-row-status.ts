/**
 * What an asset import row is, as the Excel Upload preview shows it. The stored outcome says what
 * confirming would do; for an invalid row the messages say whether the only problem is master data
 * that does not exist yet (a location or department the user can add from the preview).
 * Used by the server (counts, filters) and the preview, so both always agree.
 */
export const LOCATION_MISSING = /^Location not found: /;
export const DEPARTMENT_MISSING = /^Department not found: /;

export type ImportRowStatus = 'NEW' | 'EXISTING' | 'DUPLICATE' | 'POSSIBLE_DUPLICATE' | 'MISSING_LOCATION' | 'MISSING_DEPARTMENT' | 'MISSING_BOTH' | 'INVALID';

export function importRowStatus(outcome: string, messages: string[]): ImportRowStatus {
  if (outcome === 'CREATED') return 'NEW';
  if (outcome === 'UPDATED') return 'EXISTING';
  if (outcome === 'UNCHANGED') return 'DUPLICATE';
  if (outcome === 'WARNING') return 'POSSIBLE_DUPLICATE';
  const loc = messages.some((m) => LOCATION_MISSING.test(m));
  const dept = messages.some((m) => DEPARTMENT_MISSING.test(m));
  const other = messages.some((m) => !LOCATION_MISSING.test(m) && !DEPARTMENT_MISSING.test(m));
  if (other || (!loc && !dept)) return 'INVALID';
  return loc && dept ? 'MISSING_BOTH' : loc ? 'MISSING_LOCATION' : 'MISSING_DEPARTMENT';
}

export const ROW_STATUS_LABEL: Record<ImportRowStatus, string> = {
  NEW: 'Valid · New', EXISTING: 'Valid · Existing', DUPLICATE: 'Duplicate', POSSIBLE_DUPLICATE: 'Possible duplicate',
  MISSING_LOCATION: 'Missing location', MISSING_DEPARTMENT: 'Missing department', MISSING_BOTH: 'Missing location and department', INVALID: 'Invalid',
};
export const ROW_STATUS_TONE: Record<ImportRowStatus, string> = {
  NEW: 'green', EXISTING: 'blue', DUPLICATE: 'gray', POSSIBLE_DUPLICATE: 'amber', MISSING_LOCATION: 'amber', MISSING_DEPARTMENT: 'amber', MISSING_BOTH: 'amber', INVALID: 'red',
};

/** The preview's tabs. Each matches rows by their status; "Removed" shows rows taken out of the batch. */
export const ROW_FILTERS: { value: string; label: string; statuses?: ImportRowStatus[] }[] = [
  { value: '', label: 'All rows' },
  { value: 'VALID', label: 'Valid', statuses: ['NEW', 'EXISTING'] },
  { value: 'DUPLICATE', label: 'Duplicate', statuses: ['DUPLICATE'] },
  { value: 'POSSIBLE_DUPLICATE', label: 'Possible duplicate', statuses: ['POSSIBLE_DUPLICATE'] },
  { value: 'MISSING_LOCATION', label: 'Missing location', statuses: ['MISSING_LOCATION', 'MISSING_BOTH'] },
  { value: 'MISSING_DEPARTMENT', label: 'Missing department', statuses: ['MISSING_DEPARTMENT', 'MISSING_BOTH'] },
  { value: 'INVALID', label: 'Invalid', statuses: ['INVALID'] },
  { value: 'REMOVED', label: 'Removed' },
];

/** The value in quotes of a "… not found: "X"." message. */
export const missingValue = (m: string) => m.match(/: "(.*)"\.$/)?.[1] ?? '';
