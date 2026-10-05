/**
 * Asset ID format and QR payload helpers, shared by the server and the browser.
 * The database function itam_next_asset_code() is the authority that assigns IDs;
 * formatAssetCode() mirrors it only to preview the format on the settings screen.
 */

export interface AssetIdFormat {
  /** Fixed text at the start, e.g. AST or IT. Upper-case letters and digits. */
  prefix: string;
  /** Between the parts: "-" (AST-000001) or none (AST000001). */
  separator: '-' | '';
  /** Put the category's short code after the prefix, e.g. IT-LAP-000001. */
  includeCategoryCode: boolean;
  /** Minimum digits; the number is zero-padded to this width and grows past it if needed. */
  digits: number;
  /** GLOBAL: one running number for all assets. PER_PREFIX: each prefix (and category code) counts on its own. */
  numbering: 'GLOBAL' | 'PER_PREFIX';
  /** PER_PREFIX only: the first number a brand-new prefix starts at. */
  startNumber: number;
}

export const DEFAULT_ASSET_ID_FORMAT: AssetIdFormat = { prefix: 'AST', separator: '-', includeCategoryCode: false, digits: 6, numbering: 'GLOBAL', startNumber: 1 };

export interface LabelSettings {
  /** ASSET_ID: the QR holds only the Asset ID (any scanner). LINK: a link to the asset (opens from a phone camera). */
  qrContent: 'ASSET_ID' | 'LINK';
  /** A4_SHEET: 24 labels per A4 sheet (3 × 8). LABEL_PRINTER: one label per page at the size below. */
  layout: 'A4_SHEET' | 'LABEL_PRINTER';
  labelWidthMm: number;
  labelHeightMm: number;
  /** Also print a Code 128 barcode of the Asset ID, for 1D (laser) barcode scanners. The QR code always stays. */
  barcode: boolean;
}

export const DEFAULT_LABEL_SETTINGS: LabelSettings = { qrContent: 'ASSET_ID', layout: 'A4_SHEET', labelWidthMm: 50, labelHeightMm: 25, barcode: true };

/** The fixed text in front of the number for a given category code. */
export function assetCodeHead(f: AssetIdFormat, categoryCode?: string | null) {
  return `${f.prefix}${f.separator}${f.includeCategoryCode && categoryCode ? `${categoryCode}${f.separator}` : ''}`;
}

export function formatAssetCode(f: AssetIdFormat, n: number | bigint, categoryCode?: string | null) {
  return `${assetCodeHead(f, categoryCode)}${String(n).padStart(f.digits, '0')}`;
}

/** Path that a LINK-style QR code points to. /scan/<Asset ID> resolves and opens the asset. */
export const scanPath = (assetCode: string) => `/scan/${encodeURIComponent(assetCode)}`;

/**
 * What a scanner read, reduced to the identifier to look up. Accepts a bare Asset ID,
 * serial or legacy tag, and also a scan link (…/scan/AST-000001) so labels printed with
 * either QR content keep working in the global lookup, the scanner and verification.
 */
export function extractAssetCode(raw: string) {
  const s = raw.trim();
  const m = /^(?:https?:\/\/[^/\s]+)?\/scan\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(s);
  if (!m) return s;
  try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
}
