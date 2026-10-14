"use client";

import type { Point, Quad } from "./types";

const OPENCV_URL =
  process.env.NEXT_PUBLIC_OPENCV_URL ??
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";

/** Standard TCG card: 63 x 88 mm. */
const CARD_RATIO = 63 / 88;
const RATIO_TOLERANCE = 0.13; // perspective tilt skews the apparent ratio
const MIN_FILL = 0.85;
const MIN_AREA_FRACTION = 0.03; // a card held at arm's length from a laptop webcam

export const WARP_SHORT_SIDE = 630;
export const WARP_LONG_SIDE = 880;

// OpenCV.js has no bundled types; keep `any` contained to this module.
/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any;
let cvPromise: Promise<CV> | null = null;

export function loadOpenCV(): Promise<CV> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise<CV>((resolve, reject) => {
    // The Emscripten Module has its own `then`. Resolving a Promise with it makes the
    // Promise adopt it as a thenable and never settle, so strip `then` first.
    const ready = (mod: CV) => {
      if (Object.prototype.hasOwnProperty.call(mod, "then")) delete mod.then;
      (window as any).cv = mod;
      resolve(mod);
    };
    const onReady = () => {
      const cv = (window as any).cv;
      if (cv instanceof Promise) {
        cv.then(ready, reject);
      } else if (cv?.Mat) {
        ready(cv);
      } else if (cv) {
        cv.onRuntimeInitialized = () => ready(cv);
      } else {
        reject(new Error("OpenCV.js loaded but `cv` is missing."));
      }
    };
    if ((window as any).cv) return onReady();
    const script = document.createElement("script");
    script.src = OPENCV_URL;
    script.async = true;
    script.onload = onReady;
    script.onerror = () => reject(new Error("Failed to load OpenCV.js."));
    document.head.appendChild(script);
  });
  cvPromise.catch(() => (cvPromise = null));
  return cvPromise;
}

/** Order four points as top-left, top-right, bottom-right, bottom-left. */
function orderCorners(points: Point[]): Quad {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Average width / height of a quad, used for aspect checks and warp size. */
export function quadSize(q: Quad) {
  return {
    width: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2,
    height: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2,
  };
}

/** Median of an 8-bit single-channel Mat, for auto-tuning Canny thresholds. */
function median(mat: CV): number {
  const hist = new Uint32Array(256);
  const data: Uint8Array = mat.data;
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= data.length / 2) return v;
  }
  return 128;
}

function matToPoints(mat: CV): Point[] {
  const points: Point[] = [];
  for (let j = 0; j < mat.rows; j++) points.push({ x: mat.data32S[j * 2], y: mat.data32S[j * 2 + 1] });
  return points;
}

function polygonArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Reduce one contour to a card-shaped quad, or null. Works on the convex hull so
 * fingers or glare biting into the card edge don't break the outline, simplifies
 * progressively until four corners remain, and falls back to the min-area rectangle
 * when the hull fills it well (rounded corners often defeat polygon simplification).
 */
function contourToQuad(cv: CV, contour: CV): Quad | null {
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  try {
    cv.convexHull(contour, hull, false, true);
    const contourArea = cv.contourArea(contour);
    const perimeter = cv.arcLength(hull, true);

    let corners: Point[] | null = null;
    for (const epsilon of [0.02, 0.03, 0.045, 0.06, 0.08]) {
      cv.approxPolyDP(hull, approx, epsilon * perimeter, true);
      if (approx.rows === 4) {
        corners = matToPoints(approx);
        break;
      }
      if (approx.rows < 4) break;
    }
    if (!corners) {
      const rect = cv.minAreaRect(hull);
      corners = cv.RotatedRect.points(rect).map((p: Point) => ({ x: p.x, y: p.y }));
    }

    const quad = orderCorners(corners!);
    // The real outline (not its hull) must fill the quad. This rejects card + arm,
    // card + clutter, L-shapes etc., while a thumb biting the edge costs only a few %.
    if (contourArea / polygonArea(quad) < MIN_FILL) {
      return null;
    }
    const { width, height } = quadSize(quad);
    const ratio = Math.min(width, height) / Math.max(width, height);
    if (Math.abs(ratio - CARD_RATIO) > RATIO_TOLERANCE) {
      return null;
    }
    return quad;
  } finally {
    hull.delete();
    approx.delete();
  }
}

/**
 * Find the most card-like quadrilateral in a (downscaled) frame.
 * Returns corners in the source canvas's coordinate space, or null.
 */
export function detectCard(cv: CV, source: HTMLCanvasElement): Quad | null {
  const src = cv.imread(source);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    // Auto-tuned thresholds adapt to dim webcams and bright rooms alike.
    const m = median(gray);
    cv.Canny(gray, edges, Math.max(10, 0.5 * m), Math.min(255, Math.max(30, 1.2 * m)));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel); // bridge small gaps in the border
    // External outlines only: inner contours would let the art box (nearly card-shaped)
    // win whenever the card's own outline is broken.
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = source.width * source.height;
    let best: Quad | null = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      // Bounding-box area is a cheap upper bound; skip anything that can't win.
      const box = cv.boundingRect(contour);
      const boxArea = box.width * box.height;
      if (boxArea >= frameArea * MIN_AREA_FRACTION && boxArea > bestArea && boxArea < frameArea * 0.95) {
        const quad = contourToQuad(cv, contour);
        const area = quad ? polygonArea(quad) : 0;
        if (quad && area > bestArea) {
          best = quad;
          bestArea = area;
        }
      }
      contour.delete();
    }
    return best;
  } finally {
    src.delete();
    gray.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/** Perspective-correct the card region of a full-resolution frame into a flat canvas. */
export function warpCard(cv: CV, source: HTMLCanvasElement, quad: Quad): HTMLCanvasElement {
  const { width, height } = quadSize(quad);
  const landscape = width > height;
  const outW = landscape ? WARP_LONG_SIDE : WARP_SHORT_SIDE;
  const outH = landscape ? WARP_SHORT_SIDE : WARP_LONG_SIDE;

  const src = cv.imread(source);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const transform = cv.getPerspectiveTransform(from, to);

  try {
    cv.warpPerspective(src, dst, transform, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const out = document.createElement("canvas");
    cv.imshow(out, dst);
    return out;
  } finally {
    src.delete();
    dst.delete();
    from.delete();
    to.delete();
    transform.delete();
  }
}
