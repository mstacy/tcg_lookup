"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CameraView from "./CameraView";
import ResultPanel from "./ResultPanel";
import type { CardFeatures } from "@/lib/cardMatcher";
import { cacheScan, findCachedScan } from "@/lib/clientCache";
import { getDetector, type Detector } from "@/lib/detector";
import { dHash } from "@/lib/fingerprint";
import { OverlayRenderer } from "@/lib/overlay";
import { StabilityTracker } from "@/lib/stability";
import type { IdentifyResponse, Quad } from "@/lib/types";

const DETECT_WIDTH = 480;
const DETECT_INTERVAL_MS = 150;
const FALLBACK_MAX_SIDE = 1280;
const HISTORY_SIZE = 10;
const TIP_AFTER_MS = 4000;
const TIP_INTERVAL_MS = 3000;
/** Recent card frames kept for sharpest-frame capture (~0.5 s at 150 ms per tick). */
const FRAME_BUFFER = 3;
const FRAME_MAX_AGE_MS = 700;
const SEARCH_TIPS = [
  "Move the card closer so it fills the frame",
  "Try a plain, contrasting background",
  "Keep fingers off the card's edges",
  "Tilt the card to reduce glare",
];

type DetectorState = "loading" | "ready" | "failed";
type CardFrame = { bitmap: ImageBitmap; quad: Quad; sharpness: number; at: number };

function canvasOf(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(source, 0, 0, width, height);
  return canvas;
}

const pixels = (canvas: HTMLCanvasElement) =>
  canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);

function imageCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detectorRef = useRef<Detector | null>(null);
  const trackerRef = useRef(new StabilityTracker());
  const quadRef = useRef<Quad | null>(null); // latest quad, in detection-canvas coordinates
  const framesRef = useRef<CardFrame[]>([]);
  const busyRef = useRef(false);
  const lastCropRef = useRef<{ crop: HTMLCanvasElement; warped: boolean } | null>(null);
  // The crop behind the latest shown result, for saving eval samples in development.
  const resultCropRef = useRef<{ scannedAt: number; crop: HTMLCanvasElement } | null>(null);

  const [detector, setDetector] = useState<DetectorState>("loading");
  const [detectorMode, setDetectorMode] = useState<string | null>(null);
  const [autoScan, setAutoScan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("Starting camera…");
  const [result, setResult] = useState<IdentifyResponse | null>(null);
  const [history, setHistory] = useState<IdentifyResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDetector()
      .then((d) => {
        detectorRef.current = d;
        setDetectorMode(d.mode);
        setDetector("ready");
      })
      .catch((err) => {
        console.error(err);
        setDetector("failed");
      });
  }, []);

  const showResult = useCallback((r: IdentifyResponse, crop?: HTMLCanvasElement) => {
    if (crop) resultCropRef.current = { scannedAt: r.scannedAt, crop };
    setResult(r);
    setError(null);
    setHistory((prev) => [r, ...prev.filter((h) => h.scannedAt !== r.scannedAt)].slice(0, HISTORY_SIZE));
  }, []);

  const identify = useCallback(
    async (crop: HTMLCanvasElement, warped: boolean, fresh: boolean) => {
      lastCropRef.current = { crop, warped };

      // The 24h device cache only applies to perspective-corrected card crops;
      // full-frame fallbacks are mostly background and would match each other.
      const det = detectorRef.current;
      let fingerprint: { hash: string; features: CardFeatures } | null = null;
      if (warped && det) {
        try {
          fingerprint = { hash: dHash(crop), features: await det.features(pixels(crop)) };
          const cached = fresh ? null : await findCachedScan(det, fingerprint.hash, fingerprint.features);
          if (cached) {
            showResult({ ...cached, scannedAt: Date.now() }, crop);
            return;
          }
        } catch (err) {
          console.warn("scan cache lookup failed", err);
        }
      }

      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const image = crop.toDataURL("image/jpeg", 0.85).split(",")[1];
        const res = await fetch(`/api/identify${fresh ? "?fresh=1" : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        const response = data as IdentifyResponse;
        // Only cache confident reads, so a blurry capture doesn't pin a bad answer for 24h.
        if (fingerprint && det && response.identification.isCard && response.identification.title && response.identification.confidence !== "low") {
          await cacheScan(det, fingerprint.hash, fingerprint.features, response);
        }
        showResult(response, crop);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Scan failed.");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [showResult],
  );

  /**
   * Capture the card: the sharpest of the last few frames when a card is in view
   * (hand shake blurs some frames more than others), else the current frame.
   */
  const capture = useCallback(
    async (fresh = false) => {
      const video = videoRef.current;
      const det = detectorRef.current;
      if (!video || !video.videoWidth || busyRef.current) return;
      const { videoWidth: vw, videoHeight: vh } = video;

      const now = performance.now();
      const recent = framesRef.current.filter((f) => now - f.at < FRAME_MAX_AGE_MS);
      const sharpest = quadRef.current && recent.length ? recent.reduce((a, b) => (b.sharpness > a.sharpness ? b : a)) : null;
      if (process.env.NODE_ENV !== "production") {
        // Exposed for the e2e tests: which buffered frame was captured.
        (window as unknown as { __tcgCapture?: unknown }).__tcgCapture = {
          candidates: recent.map((f) => f.sharpness),
          chosen: sharpest?.sharpness ?? null,
        };
      }

      let crop: HTMLCanvasElement;
      let warped = false;
      try {
        if (det && sharpest) {
          const scale = sharpest.bitmap.width / DETECT_WIDTH;
          const full = pixels(canvasOf(sharpest.bitmap, sharpest.bitmap.width, sharpest.bitmap.height));
          crop = imageCanvas(await det.warp(full, sharpest.quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad));
          warped = true;
        } else if (det && quadRef.current) {
          // Prefer the averaged recent corners: steadier crop when the hand shakes.
          const quad = trackerRef.current.smoothedQuad ?? quadRef.current;
          const scale = vw / DETECT_WIDTH;
          crop = imageCanvas(await det.warp(pixels(canvasOf(video, vw, vh)), quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad));
          warped = true;
        } else {
          const s = Math.min(1, FALLBACK_MAX_SIDE / Math.max(vw, vh));
          crop = canvasOf(video, Math.round(vw * s), Math.round(vh * s));
        }
      } catch (err) {
        console.warn("warp failed, sending the whole frame", err);
        const s = Math.min(1, FALLBACK_MAX_SIDE / Math.max(vw, vh));
        crop = canvasOf(video, Math.round(vw * s), Math.round(vh * s));
      }
      void identify(crop, warped, fresh);
    },
    [identify],
  );

  const rescan = useCallback(() => {
    if (lastCropRef.current) void identify(lastCropRef.current.crop, lastCropRef.current.warped, true);
    else void capture(true);
  }, [identify, capture]);

  // Overlay animation runs from first paint, independent of the detector, so the
  // guide frame gives feedback while OpenCV is still loading.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const renderer = new OverlayRenderer(overlay);
    let frame = 0;
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const video = videoRef.current;
      const quad = quadRef.current;
      const scale = video?.videoWidth ? video.videoWidth / DETECT_WIDTH : 0;
      const tracker = trackerRef.current;
      renderer.draw(video, {
        quad: quad && scale ? (quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad) : null,
        progress: tracker.progress,
        locked: !tracker.isArmed,
        busy: busyRef.current,
      }, now);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  // Detection loop: find the card, track steadiness, auto-capture when steady.
  useEffect(() => {
    if (detector !== "ready") {
      setHint(detector === "loading" ? "Loading card detector…" : "Detector unavailable. Tap Scan to capture.");
      return;
    }
    const detectCanvas = document.createElement("canvas");
    const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true })!;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let lastHint = "";
    let searchingSince = performance.now();
    const updateHint = (h: string) => {
      if (h !== lastHint) setHint((lastHint = h));
    };
    const keepFrame = (frame: CardFrame) => {
      const frames = framesRef.current;
      frames.push(frame);
      while (frames.length > FRAME_BUFFER) frames.shift()!.bitmap.close();
    };

    const tick = async () => {
      const video = videoRef.current;
      const det = detectorRef.current;
      if (!video || !det || document.hidden) return;
      if (!video.videoWidth) return updateHint("Waiting for camera…");

      // One bitmap per tick: detection and any later capture use exactly the same frame.
      const bitmap = await createImageBitmap(video);
      detectCanvas.width = DETECT_WIDTH;
      detectCanvas.height = Math.round((bitmap.height / bitmap.width) * DETECT_WIDTH);
      detectCtx.drawImage(bitmap, 0, 0, detectCanvas.width, detectCanvas.height);

      let detection = null;
      try {
        detection = await det.detect(detectCtx.getImageData(0, 0, detectCanvas.width, detectCanvas.height));
      } catch (err) {
        console.warn("detect failed", err);
      }
      if (stopped) return bitmap.close();
      const quad = detection?.quad ?? null;
      quadRef.current = quad;
      if (detection) {
        keepFrame({ bitmap, quad: detection.quad, sharpness: detection.sharpness, at: performance.now() });
        searchingSince = performance.now();
      } else {
        bitmap.close();
      }

      const tracker = trackerRef.current;
      const shouldCapture = !busyRef.current && tracker.update(quad);
      if (shouldCapture && autoScan) await capture();

      if (busyRef.current) updateHint("Identifying…");
      else if (!quad) {
        // After a while with nothing detected, rotate through tips instead of a static prompt.
        const searching = performance.now() - searchingSince;
        updateHint(
          searching < TIP_AFTER_MS
            ? "Place the card inside the frame"
            : SEARCH_TIPS[Math.floor((searching - TIP_AFTER_MS) / TIP_INTERVAL_MS) % SEARCH_TIPS.length],
        );
      } else if (!tracker.isArmed) updateHint("Scanned. Show the next card.");
      else updateHint(autoScan ? "Hold steady…" : "Card found. Tap Scan.");
    };

    // Schedule the next tick after this one finishes, so slow frames never pile up.
    const loop = async () => {
      try {
        await tick();
      } finally {
        if (!stopped) timer = setTimeout(loop, DETECT_INTERVAL_MS);
      }
    };
    void loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [detector, autoScan, capture]);

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100 md:flex-row" data-detector={detectorMode ?? undefined}>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <CameraView videoRef={videoRef} />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        <div className="absolute inset-x-0 top-3 flex justify-center px-16">
          <span className="rounded-full bg-black/60 px-4 py-1.5 text-sm backdrop-blur">{hint}</span>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <label className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-2 text-sm backdrop-blur">
            <input type="checkbox" checked={autoScan} onChange={(e) => setAutoScan(e.target.checked)} className="accent-emerald-500" />
            Auto
          </label>
          <button
            onClick={() => {
              trackerRef.current.reset();
              void capture();
            }}
            disabled={busy}
            className="h-16 w-16 rounded-full border-4 border-white bg-white/20 text-sm font-semibold backdrop-blur transition active:scale-95 disabled:opacity-50"
          >
            {busy ? <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" /> : "Scan"}
          </button>
          <span className="w-[72px]" />
        </div>
      </div>

      <aside className="max-h-[45dvh] shrink-0 border-t border-neutral-800 bg-neutral-900 md:max-h-none md:w-96 md:border-l md:border-t-0">
        <ResultPanel
          result={result}
          history={history}
          error={error}
          busy={busy}
          onRescan={rescan}
          onSelect={setResult}
          getSampleImage={(r) =>
            resultCropRef.current?.scannedAt === r.scannedAt ? resultCropRef.current.crop.toDataURL("image/jpeg", 0.9).split(",")[1] : null
          }
        />
      </aside>
    </main>
  );
}
