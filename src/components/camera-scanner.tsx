'use client';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

/** QR (our labels) plus the 1D/2D codes manufacturers print on serial stickers. */
const FORMATS = ['qr_code', 'code_128', 'code_39', 'data_matrix', 'ean_13', 'ean_8', 'upc_a', 'itf'] as const;

type Detected = { rawValue: string; format: string };
type Detector = { detect(source: CanvasImageSource): Promise<Detected[]> };
let cached: Promise<Detector> | null = null;

/** The browser's BarcodeDetector where it supports QR (Android, macOS), otherwise zxing-wasm served from /zxing. */
function getDetector(): Promise<Detector> {
  cached ??= (async () => {
    const Native = (globalThis as { BarcodeDetector?: { new (o: object): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
    if (Native) {
      try {
        const supported = await Native.getSupportedFormats();
        if (supported.includes('qr_code')) return new Native({ formats: FORMATS.filter((f) => supported.includes(f)) });
      } catch { /* fall through to wasm */ }
    }
    const mod = await import('barcode-detector/ponyfill');
    mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `/zxing/${path}` : prefix + path) } });
    return new mod.BarcodeDetector({ formats: [...FORMATS] }) as unknown as Detector;
  })();
  cached.catch(() => { cached = null; });
  return cached;
}

let audio: AudioContext | null = null;
/** Short beep and vibration, so the operator need not look at the screen after every scan. */
export function scanFeedback(kind: 'ok' | 'warn' | 'error') {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = kind === 'ok' ? 1800 : kind === 'warn' ? 900 : 300;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (kind === 'error' ? 0.3 : 0.08));
  } catch { /* audio unavailable */ }
  navigator.vibrate?.(kind === 'ok' ? 40 : kind === 'warn' ? [40, 60, 40] : 200);
}

/**
 * Live camera preview that reports each code it reads. The same code is ignored for
 * `repeatDelay` ms so holding a label in view does not scan it repeatedly.
 */
export function CameraScanner({ onDetect, paused, repeatDelay = 2500 }: { onDetect: (code: string) => void; paused?: boolean; repeatDelay?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const last = useRef({ code: '', at: 0 });
  const onDetectRef = useRef(onDetect);
  const pausedRef = useRef(paused);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [hit, setHit] = useState(false);
  useEffect(() => { onDetectRef.current = onDetect; pausedRef.current = paused; });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('The camera needs a secure (HTTPS) connection. Type the Asset ID or use a USB scanner instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const name = (e as DOMException)?.name;
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or type the Asset ID below.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera was found on this device. Type the Asset ID or use a USB scanner instead.'
            : 'The camera could not be started. It may be in use by another app. Type the Asset ID below instead.');
        return;
      } finally { setStarting(false); }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; focusMode?: string[] };
      if (caps.torch) setTorch(false);
      if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      let detector: Detector;
      try { detector = await getDetector(); } catch {
        setError('The code reader could not be loaded. Type the Asset ID or use a USB scanner instead.');
        return;
      }
      const tick = async () => {
        if (stopped) return;
        if (!pausedRef.current && video.readyState >= 2) {
          try {
            const c = (await detector.detect(video)).find((x) => x.rawValue?.trim());
            if (c) {
              const code = c.rawValue.trim();
              const now = Date.now();
              if (code !== last.current.code || now - last.current.at > repeatDelay) {
                last.current = { code, at: now };
                setHit(true);
                setTimeout(() => setHit(false), 250);
                onDetectRef.current(code);
              }
            }
          } catch { /* frame not ready */ }
        }
        timer = setTimeout(tick, 120);
      };
      tick();
    })();
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [repeatDelay]);

  const toggleTorch = async () => {
    const next = !torch;
    await trackRef.current?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] }).catch(() => undefined);
    setTorch(next);
  };

  if (error) return <div role="alert" className="flex aspect-[4/3] w-full items-center justify-center rounded-md border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">{error}</div>;
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-slate-900">
      <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-label="Camera preview" />
      <div className={clsx('pointer-events-none absolute inset-x-[18%] top-1/2 aspect-square max-h-[70%] -translate-y-1/2 rounded-lg border-2 transition', hit ? 'border-green-400 bg-green-400/20' : 'border-white/80')} />
      {starting && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting camera…</div>}
      {paused && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-medium text-white">Paused</div>}
      {torch !== null && <button type="button" onClick={toggleTorch} className="btn btn-sm absolute bottom-2 right-2 border-transparent bg-black/60 text-white hover:bg-black/70">{torch ? 'Light off' : 'Light on'}</button>}
    </div>
  );
}
