"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CameraView from "./CameraView";
import ResultPanel from "./ResultPanel";
import { detectCard, loadOpenCV, warpCard } from "@/lib/cardDetector";
import { cacheScan, findCachedScan } from "@/lib/clientCache";
import { extractFeatures } from "@/lib/cardMatcher";
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
const SEARCH_TIPS = [
  "Move the card closer so it fills the frame",
  "Try a plain, contrasting background",
  "Keep fingers off the card's edges",
  "Tilt the card to reduce glare",
];

type DetectorState = "loading" | "ready" | "failed";

/* eslint-disable @typescript-eslint/no-explicit-any */

function drawFrame(video: HTMLVideoElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
  return canvas;
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cvRef = useRef<any>(null);
  const trackerRef = useRef(new StabilityTracker());
  const quadRef = useRef<Quad | null>(null); // latest quad, in detection-canvas coordinates
  const busyRef = useRef(false);
  const lastCropRef = useRef<{ crop: HTMLCanvasElement; warped: boolean } | null>(null);
  // The crop behind the latest shown result, for saving eval samples in development.
  const resultCropRef = useRef<{ scannedAt: number; crop: HTMLCanvasElement } | null>(null);

  const [detector, setDetector] = useState<DetectorState>("loading");
  const [autoScan, setAutoScan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("Starting camera…");
  const [result, setResult] = useState<IdentifyResponse | null>(null);
  const [history, setHistory] = useState<IdentifyResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOpenCV()
      .then((cv) => {
        cvRef.current = cv;
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
      const cv = cvRef.current;
      let fingerprint: { hash: string; features: ReturnType<typeof extractFeatures> } | null = null;
      if (warped && cv) {
        try {
          fingerprint = { hash: dHash(crop), features: extractFeatures(cv, crop) };
          const cached = fresh ? null : findCachedScan(cv, fingerprint.hash, fingerprint.features);
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
        if (fingerprint && response.identification.isCard && response.identification.title && response.identification.confidence !== "low") {
          cacheScan(cv, fingerprint.hash, fingerprint.features, response);
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

  /** Capture the current frame, cropping to the detected card when there is one. */
  const capture = useCallback(
    (fresh = false) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth || busyRef.current) return;
      const { videoWidth: vw, videoHeight: vh } = video;
      const full = drawFrame(video, vw, vh);
      // Prefer the averaged recent corners: steadier crop when the hand shakes.
      const quad = quadRef.current ? (trackerRef.current.smoothedQuad ?? quadRef.current) : null;
      const cv = cvRef.current;

      let crop: HTMLCanvasElement;
      const warped = Boolean(quad && cv);
      if (quad && cv) {
        const scale = vw / DETECT_WIDTH;
        crop = warpCard(cv, full, quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad);
      } else {
        const s = Math.min(1, FALLBACK_MAX_SIDE / Math.max(vw, vh));
        crop = s < 1 ? drawFrame(video, Math.round(vw * s), Math.round(vh * s)) : full;
      }
      void identify(crop, warped, fresh);
    },
    [identify],
  );

  const rescan = useCallback(() => {
    if (lastCropRef.current) void identify(lastCropRef.current.crop, lastCropRef.current.warped, true);
    else capture(true);
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
    let timer: ReturnType<typeof setTimeout>;
    let lastHint = "";
    let searchingSince = performance.now();
    const updateHint = (h: string) => {
      if (h !== lastHint) setHint((lastHint = h));
    };

    const tick = () => {
      timer = setTimeout(tick, DETECT_INTERVAL_MS);
      const video = videoRef.current;
      if (!video || document.hidden) return;
      if (!video.videoWidth) return updateHint("Waiting for camera…");

      const { videoWidth: vw, videoHeight: vh } = video;
      detectCanvas.width = DETECT_WIDTH;
      detectCanvas.height = Math.round((vh / vw) * DETECT_WIDTH);
      detectCanvas.getContext("2d", { willReadFrequently: true })!.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);

      let quad: Quad | null = null;
      try {
        quad = detectCard(cvRef.current, detectCanvas);
      } catch (err) {
        console.warn("detectCard failed", err);
      }
      quadRef.current = quad;
      if (quad) searchingSince = performance.now();

      const tracker = trackerRef.current;
      const shouldCapture = !busyRef.current && tracker.update(quad);

      if (busyRef.current) updateHint("Identifying…");
      else if (!quad) {
        // After a while with nothing detected, rotate through tips instead of a static prompt.
        const searching = performance.now() - searchingSince;
        updateHint(
          searching < TIP_AFTER_MS
            ? "Place the card inside the frame"
            : SEARCH_TIPS[Math.floor((searching - TIP_AFTER_MS) / TIP_INTERVAL_MS) % SEARCH_TIPS.length],
        );
      }
      else if (!tracker.isArmed) updateHint("Scanned. Show the next card.");
      else updateHint(autoScan ? "Hold steady…" : "Card found. Tap Scan.");

      if (shouldCapture && autoScan) capture();
    };
    tick();
    return () => clearTimeout(timer);
  }, [detector, autoScan, capture]);

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100 md:flex-row">
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
              capture();
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
