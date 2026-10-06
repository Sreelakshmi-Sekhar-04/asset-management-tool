import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { code128Widths } from '@/lib/code128';

const root = path.resolve(__dirname, '..');
const served = readFileSync(path.join(root, 'public/vendor/zxing_reader.wasm'));

/**
 * A Code 128 barcode as a laptop webcam sees it: 640×480, 1.5 pixels per module and slightly blurred.
 * The JavaScript ZXing port cannot read this; the WebAssembly reader the camera scanner uses can.
 */
function webcamFrame(text: string) {
  const W = 640, H = 480;
  const widths = code128Widths(text);
  // Draw at 3 px per module, then average pixel pairs down to 1.5 px per module.
  const fine: number[] = [];
  widths.forEach((w, i) => { for (let k = 0; k < w * 3; k++) fine.push(i % 2 === 0 ? 0 : 255); });
  const row = Array.from({ length: Math.ceil(fine.length / 2) }, (_, i) => ((fine[2 * i] ?? 255) + (fine[2 * i + 1] ?? 255)) / 2);
  const blurred = row.map((v, i) => ((row[i - 1] ?? 255) + 4 * v + (row[i + 1] ?? 255)) / 6);
  const x0 = Math.round((W - blurred.length) / 2), y0 = 200, h = 60;
  const data = new Uint8ClampedArray(W * H * 4).fill(235);
  for (let y = y0; y < y0 + h; y++) blurred.forEach((v, i) => { const o = (y * W + x0 + i) * 4; data[o] = data[o + 1] = data[o + 2] = v; });
  for (let o = 3; o < data.length; o += 4) data[o] = 255;
  return { data, width: W, height: H, colorSpace: 'srgb' as const };
}

describe('camera serial-number decoder', () => {
  it('serves the same .wasm file as the installed zxing-wasm package', () => {
    const installed = readFileSync(path.join(root, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'));
    expect(served.equals(installed), 'public/vendor/zxing_reader.wasm is stale: copy it from node_modules/zxing-wasm/dist/reader/').toBe(true);
  });

  it('reads a low-resolution, blurred Code 128 serial', async () => {
    await prepareZXingModule({ overrides: { wasmBinary: served.buffer.slice(served.byteOffset, served.byteOffset + served.byteLength) as ArrayBuffer }, fireImmediately: true });
    const r = await readBarcodes(webcamFrame('5CG1234XYZ') as unknown as ImageData, { formats: ['Code128'], tryHarder: true });
    expect(r.map((x) => x.text)).toEqual(['5CG1234XYZ']);
  });
});
