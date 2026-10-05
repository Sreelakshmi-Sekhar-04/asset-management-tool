'use client';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

type State = { kind: 'starting' } | { kind: 'scanning' } | { kind: 'error'; message: string };

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare global {
  interface Window { BarcodeDetector?: { new (opts: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }
}

/** Plain-language reason the camera could not start. */
function cameraError(e: unknown) {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again. You can still type or scan the Asset ID below.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Type the Asset ID below, or use a USB barcode scanner.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is being used by another app. Close it and try again.';
  return 'The camera could not be started. Type or scan the Asset ID below instead.';
}

/**
 * Live camera QR reader. Uses the browser's built-in BarcodeDetector where available
 * (Chrome on Android, which also reads the label's Code 128 barcode) and the bundled jsQR
 * decoder elsewhere (iPhone, desktop), which reads the QR code.
 * Calls onScan once per code; the same code is ignored for a few seconds.
 */
export function CameraScanner({ onScan, paused = false, className }: { onScan: (text: string) => void; paused?: boolean; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const pausedRef = useRef(paused);
  const onScanRef = useRef(onScan);
  pausedRef.current = paused;
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let alive = true;
    let last = { text: '', at: 0 };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const start = async () => {
      setState({ kind: 'starting' });
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState({ kind: 'error', message: 'The camera needs a secure (https) connection. Ask your administrator, or type the Asset ID below.' });
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        if (alive) setState({ kind: 'error', message: cameraError(e) });
        return;
      }
      if (!alive || !video.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);

      let detect: (v: HTMLVideoElement) => Promise<string | null>;
      const formats: string[] = (await window.BarcodeDetector?.getSupportedFormats?.().catch(() => [] as string[])) ?? [];
      const native = formats.includes('qr_code');
      if (native && window.BarcodeDetector) {
        // Where the browser can, also read the Code 128 barcode printed under the QR code.
        const d = new window.BarcodeDetector({ formats: ['qr_code', ...(formats.includes('code_128') ? ['code_128'] : [])] });
        detect = async (v) => (await d.detect(v))[0]?.rawValue ?? null;
      } else {
        const jsQR = (await import('jsqr')).default;
        detect = async (v) => {
          if (!ctx || !v.videoWidth) return null;
          const scale = Math.min(1, 640 / v.videoWidth);
          canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
        };
      }
      if (!alive) return;
      setState({ kind: 'scanning' });
      let busy = false, lastTick = 0;
      const tick = (now: number) => {
        if (!alive) return;
        raf = requestAnimationFrame(tick);
        if (busy || pausedRef.current || now - lastTick < 150 || !video.current || video.current.readyState < 2) return;
        lastTick = now; busy = true;
        detect(video.current).then((text) => {
          if (!text) return;
          const t = Date.now();
          if (text === last.text && t - last.at < 3000) return;
          last = { text, at: t };
          navigator.vibrate?.(60);
          onScanRef.current(text);
        }).catch(() => undefined).finally(() => { busy = false; });
      };
      raf = requestAnimationFrame(tick);
    };
    start();
    return () => { alive = false; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [attempt]);

  return (
    <div className={className}>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md bg-slate-900">
        <video ref={video} className="h-full w-full object-cover" muted playsInline aria-label="Camera view" />
        {state.kind === 'scanning' && <div className="pointer-events-none absolute inset-[18%] rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]" />}
        {state.kind === 'starting' && <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white"><Spinner className="border-slate-500 border-t-white" />Starting camera…</div>}
        {state.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-white">
            <p>{state.message}</p>
            <button className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </div>
        )}
        {paused && state.kind === 'scanning' && <div className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-xs text-white">Paused</div>}
      </div>
      {state.kind === 'scanning' && <p className="mt-1 text-center text-xs text-slate-500">Hold the label inside the frame.</p>}
    </div>
  );
}
