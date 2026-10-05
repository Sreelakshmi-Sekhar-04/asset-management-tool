import net from 'node:net';

export type ScanResult = 'CLEAN' | 'INFECTED' | 'NOT_SCANNED' | 'ERROR';

/**
 * Virus-scan hook (FR-DOC-02). VIRUS_SCAN_MODE:
 *  - none (default): files are stored as NOT_SCANNED
 *  - clamav: stream to clamd over TCP (CLAMAV_HOST / CLAMAV_PORT) using INSTREAM
 *  - http: POST the bytes to VIRUS_SCAN_URL; a JSON body {"clean": boolean} is expected
 * An infected result rejects the upload; an ERROR is stored and surfaced (VIRUS_SCAN_FAIL_CLOSED=true rejects it).
 */
export async function scanBuffer(buf: Buffer): Promise<ScanResult> {
  const mode = process.env.VIRUS_SCAN_MODE ?? 'none';
  try {
    if (mode === 'clamav') return await clamd(buf);
    if (mode === 'http' && process.env.VIRUS_SCAN_URL) {
      const r = await fetch(process.env.VIRUS_SCAN_URL, { method: 'POST', body: new Uint8Array(buf), headers: { 'content-type': 'application/octet-stream' } });
      const j = (await r.json()) as { clean?: boolean };
      return j.clean ? 'CLEAN' : 'INFECTED';
    }
    return 'NOT_SCANNED';
  } catch {
    return 'ERROR';
  }
}

function clamd(buf: Buffer): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = net.connect(Number(process.env.CLAMAV_PORT ?? 3310), process.env.CLAMAV_HOST ?? '127.0.0.1');
    let out = '';
    sock.setTimeout(30_000, () => { sock.destroy(); resolve('ERROR'); });
    sock.on('error', () => resolve('ERROR'));
    sock.on('data', (d) => (out += d.toString()));
    sock.on('end', () => resolve(/OK/.test(out) && !/FOUND/.test(out) ? 'CLEAN' : /FOUND/.test(out) ? 'INFECTED' : 'ERROR'));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.end(Buffer.alloc(4));
    });
  });
}
