/**
 * The asset register's single Status.
 *
 * An asset has two stored facts: its lifecycle status (In stock, Assigned, Under repair, Retired)
 * and where its latest transfer stands. People see one Status, derived here from both, so the two
 * can never be shown out of step. A transfer in progress, or the outcome of the latest one, takes
 * precedence; the outcome gives way to the lifecycle status at the asset's next change
 * (recordMovement clears it).
 */
export const ASSET_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock',
  ASSIGNED: 'Assigned',
  UNDER_REPAIR: 'Under repair',
  RETIRED: 'Retired',
  PENDING_TRANSFER_APPROVAL: 'Pending transfer approval',
  PENDING_LOCATION_MANAGER_APPROVAL: 'Pending location manager approval',
  TRANSFER_APPROVED: 'Transfer approved · awaiting receipt',
  TRANSFER_NOT_RECEIVED: 'Transfer exception · not received',
  TRANSFERRED: 'Transferred',
  TRANSFER_REJECTED: 'Transfer rejected',
};

export const ASSET_STATUS_TONE: Record<string, string> = {
  IN_STOCK: 'blue', ASSIGNED: 'green', UNDER_REPAIR: 'amber', RETIRED: 'gray',
  PENDING_TRANSFER_APPROVAL: 'amber', PENDING_LOCATION_MANAGER_APPROVAL: 'amber', TRANSFER_APPROVED: 'purple',
  TRANSFER_NOT_RECEIVED: 'red', TRANSFERRED: 'green', TRANSFER_REJECTED: 'red',
};

/** Transfer state → the Status it shows as; NONE shows the lifecycle status. */
export const TRANSFER_DISPLAY: Record<string, string> = {
  PENDING_ADMIN: 'PENDING_TRANSFER_APPROVAL',
  PENDING_LOCATION_MANAGER: 'PENDING_LOCATION_MANAGER_APPROVAL',
  APPROVED: 'TRANSFER_APPROVED',
  NOT_RECEIVED: 'TRANSFER_NOT_RECEIVED',
  RECEIVED: 'TRANSFERRED',
  REJECTED: 'TRANSFER_REJECTED',
};

export function displayStatus(status: string, transferStatus: string | null | undefined): string {
  if (status === 'RETIRED') return 'RETIRED';
  return (transferStatus && TRANSFER_DISPLAY[transferStatus]) || status;
}

/** Status filter value → the stored values it matches (the inverse of displayStatus). */
export function statusFilterParts(value: string): { status?: string; transferStatus: string[] } | null {
  if (['IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR'].includes(value)) return { status: value, transferStatus: ['NONE'] };
  if (value === 'RETIRED') return { status: 'RETIRED', transferStatus: [] };
  const ts = Object.entries(TRANSFER_DISPLAY).filter(([, d]) => d === value).map(([t]) => t);
  return ts.length ? { transferStatus: ts } : null;
}

/** Order of the options in the Status filter. */
export const ASSET_STATUS_OPTIONS = [
  'IN_STOCK', 'ASSIGNED', 'UNDER_REPAIR', 'PENDING_TRANSFER_APPROVAL', 'PENDING_LOCATION_MANAGER_APPROVAL',
  'TRANSFER_APPROVED', 'TRANSFER_NOT_RECEIVED', 'TRANSFERRED', 'TRANSFER_REJECTED', 'RETIRED',
];

/** Condition recorded when the destination confirms what arrived. */
export const RECEIPT_CONDITION_LABEL: Record<string, string> = {
  GOOD: 'Good', DAMAGED: 'Damaged', PARTIALLY_DAMAGED: 'Partially damaged', NOT_RECEIVED: 'Not received',
};
