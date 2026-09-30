// Shared formatting (NFR-13: dates DD-MMM-YYYY, times IST, currency INR).
const TZ = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return p as Record<string, string>;
}

export function fmtDate(v?: string | Date | null): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (isNaN(d.getTime())) return '—';
  // Date-only values are stored at UTC midnight; show them without timezone shift.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(v)) {
    return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  }
  const p = parts(d);
  return `${p.day}-${MONTHS[Number(p.month) - 1]}-${p.year}`;
}

export function fmtDateOnly(v?: string | Date | null): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

export function fmtDateTime(v?: string | Date | null): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (isNaN(d.getTime())) return '—';
  const p = parts(d);
  return `${p.day}-${MONTHS[Number(p.month) - 1]}-${p.year} ${p.hour}:${p.minute} IST`;
}

export function fmtINR(v?: string | number | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayIST(): string {
  const p = parts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

/** A YYYY-MM-DD string as a UTC-midnight Date (how @db.Date values are stored). */
export function dateOnly(s: string | Date): Date {
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000);
}
