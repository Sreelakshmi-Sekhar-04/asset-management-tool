export const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock', ASSIGNED: 'Assigned', UNDER_REPAIR: 'Under repair', RETIRED: 'Retired',
};
export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Administrator', IT_OPERATOR: 'IT Operator', BRANCH_USER: 'Branch User' };
export const TRANSFER_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', IN_TRANSIT: 'In transit', PARTIALLY_RECEIVED: 'Partially received',
  COMPLETED: 'Completed', REJECTED: 'Rejected', CANCELLED: 'Cancelled',
};
export const LINE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', IN_TRANSIT: 'In transit', RECEIVED: 'Received',
  NOT_RECEIVED: 'Not received', RECALLED: 'Recalled', CANCELLED: 'Cancelled',
};
export const HOLDER_TYPE_LABEL: Record<string, string> = { EMPLOYEE: 'Employee', DEPARTMENT: 'Department', LOCATION: 'Location' };
export const MOVEMENT_LABEL: Record<string, string> = {
  REGISTERED: 'Registered', IMPORTED: 'Imported', ASSIGNED: 'Assigned', CHECKED_IN: 'Checked in',
  REPAIR_STARTED: 'Repair started', REPAIR_COMPLETED: 'Repair completed', RETIRED: 'Retired',
  TRANSFER_RECEIVED: 'Transfer received', TRANSFER_NOT_RECEIVED: 'Transfer not received', TRANSFERRED: 'Transferred',
  CORRECTION: 'Correction',
};
/**
 * Actions an approval policy can gate. Transfers (assets assigned to a location) are not here:
 * they always need an Administrator and then the destination's location manager.
 */
export const APPROVAL_ACTION_LABEL: Record<string, string> = {
  ASSET_CREATE: 'Asset create', ASSIGN: 'Assign', CHECK_IN: 'Check-in', RETIRE: 'Retire', STATUS_CHANGE: 'Repair / status change',
};
/** Every action a request can carry, transfers included. */
export const HISTORIC_ACTION_LABEL: Record<string, string> = { ...APPROVAL_ACTION_LABEL, TRANSFER: 'Transfer' };
/** The asset register's Transfer status column. */
export const ASSET_TRANSFER_STATUS_LABEL: Record<string, string> = {
  NONE: 'No transfer', PENDING_ADMIN: 'Pending admin approval', PENDING_LOCATION_MANAGER: 'Pending location manager approval',
  APPROVED: 'Transferred', REJECTED: 'Transfer rejected',
};
export const RENEWABLE_TYPE_LABEL: Record<string, string> = {
  WARRANTY: 'Warranty', LICENCE: 'Licence', SUBSCRIPTION: 'Subscription', AMC: 'AMC', CALIBRATION: 'Calibration',
  INSURANCE: 'Insurance', CERTIFICATE: 'Certificate', OTHER: 'Other',
};
export const DISPOSAL_LABEL: Record<string, string> = { SCRAPPED: 'Scrapped', SOLD: 'Sold', DONATED: 'Donated', LOST: 'Lost' };
export const VER_TASK_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', SUBMITTED: 'Submitted', SIGNED_OFF: 'Signed off',
};
export function label(map: Record<string, string>, v?: string | null) {
  return v ? map[v] ?? v : '—';
}
