import { detectCard, sharpness, warpCard } from "./cardDetector";
import { extractFeatures, isSameCard, type CardFeatures } from "./cardMatcher";
import type { CV } from "./opencv";
import type { Quad } from "./types";

export type Detection = { quad: Quad; sharpness: number };

const MATCH_BUDGET_MS = 600; // ORB match is ~30 ms per candidate

/** The OpenCV work behind the scanner, shared by the Web Worker and the main-thread fallback. */
export function detectorOps(cv: CV) {
  return {
    detect(image: ImageData): Detection | null {
      const quad = detectCard(cv, image);
      return quad ? { quad, sharpness: sharpness(cv, image, quad) } : null;
    },
    warp(image: ImageData, quad: Quad): ImageData {
      return warpCard(cv, image, quad);
    },
    features(image: ImageData): CardFeatures {
      return extractFeatures(cv, image);
    },
    /** Index of the first candidate showing the same card (callers order likeliest first), or -1. */
    match(features: CardFeatures, candidates: CardFeatures[]): number {
      const deadline = performance.now() + MATCH_BUDGET_MS;
      for (let i = 0; i < candidates.length; i++) {
        if (isSameCard(cv, features, candidates[i])) return i;
        if (performance.now() > deadline) break;
      }
      return -1;
    },
  };
}

export type DetectorOps = ReturnType<typeof detectorOps>;
export type DetectorOp = keyof DetectorOps;
