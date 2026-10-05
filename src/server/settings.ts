import { prisma, type Db } from '@/lib/db';
import { DEFAULT_ASSET_ID_FORMAT, DEFAULT_LABEL_SETTINGS, type AssetIdFormat, type LabelSettings } from '@/lib/asset-code';

export type DuplicateSeverity = 'BLOCK' | 'WARN' | 'OFF';

/** Admin-configurable settings (NFR-14: change without redeploy). */
export interface Settings {
  orgName: string;
  orgLogoDocumentId: string | null;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  transferAgingDays: number;
  duplicateRules: { serial: DuplicateSeverity; hostname: DuplicateSeverity; ip: DuplicateSeverity };
  maxFileSizeMB: number;
  maxFilesPerRecord: number;
  allowedFileTypes: string[];
  imageMaxDimension: number;
  documentRetentionYears: number;
  auditRetentionYears: number;
  importReportRetentionMonths: number;
  scannerAdvanceKey: 'Enter' | 'Tab';
  verificationReminderDays: number[];
  notificationEmail: Record<string, boolean>;
  /** Read by the database when it assigns an Asset ID; change it through the Asset IDs & labels screen. */
  assetIdFormat: AssetIdFormat;
  labels: LabelSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  orgName: 'IT Asset Lifecycle Management',
  orgLogoDocumentId: null,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 12,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
  passwordMinLength: 10,
  transferAgingDays: 7,
  duplicateRules: { serial: 'BLOCK', hostname: 'WARN', ip: 'WARN' },
  maxFileSizeMB: 5,
  maxFilesPerRecord: 20,
  allowedFileTypes: [
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv',
  ],
  imageMaxDimension: 1920,
  documentRetentionYears: 7,
  auditRetentionYears: 7,
  importReportRetentionMonths: 12,
  scannerAdvanceKey: 'Enter',
  verificationReminderDays: [7, 1],
  notificationEmail: {
    TRANSFER_APPROVAL_REQUESTED: true, TRANSFER_DECIDED: true, TRANSFER_IN_TRANSIT: true, TRANSFER_EXCEPTION: true,
    TRANSFER_RECEIVED: false, TRANSFER_COMPLETED: false, TRANSFER_AGING: true, APPROVAL_REQUESTED: true, APPROVAL_DECIDED: true,
    VERIFICATION: true, RENEWAL: true, INTEGRATION_FAILURE: true, IMPORT_COMPLETED: false,
  },
  assetIdFormat: DEFAULT_ASSET_ID_FORMAT,
  labels: DEFAULT_LABEL_SETTINGS,
};

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(db: Db = prisma): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const rows = await db.setting.findMany();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;
  merged.duplicateRules = { ...DEFAULT_SETTINGS.duplicateRules, ...(merged.duplicateRules as object) };
  merged.notificationEmail = { ...DEFAULT_SETTINGS.notificationEmail, ...(merged.notificationEmail as object) };
  merged.assetIdFormat = { ...DEFAULT_SETTINGS.assetIdFormat, ...(merged.assetIdFormat as object) };
  merged.labels = { ...DEFAULT_SETTINGS.labels, ...(merged.labels as object) };
  const value = merged as unknown as Settings;
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettings() {
  cache = null;
}
