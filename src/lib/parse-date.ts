const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Accepts YYYY-MM-DD, DD-MMM-YYYY, DD/MM/YYYY and DD-MM-YYYY. Returns YYYY-MM-DD or null if invalid. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  let mm: RegExpMatchArray | null;
  if ((mm = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/))) [d, m, y] = [Number(mm[1]), MON[mm[2].toLowerCase()] ?? 0, Number(mm[3])];
  else if ((mm = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) [d, m, y] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
