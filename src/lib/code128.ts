/**
 * Code 128 barcode encoder (sets B and C), for the 1D barcode on asset labels.
 * Returns bar/space widths in modules, starting with a bar; quiet zones are the caller's.
 * Runs of 4+ digits switch to set C (two digits per symbol) to keep the barcode short.
 */

// Widths for symbol values 0–106 (106 = stop, which has a 7th element).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

export function code128Values(text: string): number[] {
  if (!text) throw new Error('Nothing to encode');
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`Character "${ch}" cannot be encoded in Code 128 set B`);
  }
  const digitRun = (i: number) => { let j = i; while (j < text.length && text[j] >= '0' && text[j] <= '9') j++; return j - i; };
  const values: number[] = [];
  let set: 'B' | 'C';
  let i = 0;
  const lead = digitRun(0);
  if (lead >= 4 && (lead === text.length || lead >= 6)) { set = 'C'; values.push(START_C); }
  else { set = 'B'; values.push(START_B); }
  while (i < text.length) {
    const run = digitRun(i);
    const toC = set === 'B' && run >= 4 && (i + run === text.length || run >= 6);
    if (toC) {
      if (run % 2 === 1) { values.push(text.charCodeAt(i) - 32); i++; }
      values.push(CODE_C); set = 'C';
    }
    if (set === 'C') {
      if (digitRun(i) >= 2) { values.push(Number(text.slice(i, i + 2))); i += 2; continue; }
      values.push(CODE_B); set = 'B';
    }
    values.push(text.charCodeAt(i) - 32); i++;
  }
  const check = values.reduce((sum, v, k) => sum + v * (k === 0 ? 1 : k), 0) % 103;
  return [...values, check, STOP];
}

/** Alternating bar/space widths in modules, first element a bar. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap((v) => PATTERNS[v].split('').map(Number));
}
