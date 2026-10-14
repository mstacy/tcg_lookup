"use client";

/**
 * Decides whether two captures show the same card, using ORB keypoints and a
 * RANSAC homography. Robust to angle, lighting and blur; distinct cards (different
 * art and text) share few geometrically consistent matches even with the same frame.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type CV = any;

export type CardFeatures = {
  /** Keypoint coordinates, flattened [x0, y0, x1, y1, ...]. */
  points: number[];
  /** ORB descriptors (rows x 32 bytes), base64-encoded for storage. */
  descriptors: string;
  rows: number;
};

const ORB_FEATURES = 500;
const FEATURE_WIDTH = 315; // half of the warped card width; plenty for ORB, ~4x faster
const RATIO_TEST = 0.75;
// Calibrated on test captures: same card ≥126 inliers (≥27% of keypoints),
// different cards ≤41 (≤9%). Both thresholds must pass.
const MIN_INLIERS = 60;
const MIN_INLIER_FRACTION = 0.15;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export function extractFeatures(cv: CV, card: HTMLCanvasElement): CardFeatures {
  const small = document.createElement("canvas");
  small.width = FEATURE_WIDTH;
  small.height = Math.round((card.height / card.width) * FEATURE_WIDTH);
  small.getContext("2d")!.drawImage(card, 0, 0, small.width, small.height);

  const src = cv.imread(small);
  const gray = new cv.Mat();
  const noMask = new cv.Mat();
  const orb = new cv.ORB(ORB_FEATURES);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, noMask, keypoints, descriptors);
    const points: number[] = [];
    for (let i = 0; i < keypoints.size(); i++) {
      const { x, y } = keypoints.get(i).pt;
      points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    }
    return { points, descriptors: toBase64(new Uint8Array(descriptors.data)), rows: descriptors.rows };
  } finally {
    src.delete();
    gray.delete();
    noMask.delete();
    orb.delete();
    keypoints.delete();
    descriptors.delete();
  }
}

function descriptorMat(cv: CV, f: CardFeatures) {
  const mat = new cv.Mat(f.rows, 32, cv.CV_8U);
  mat.data.set(fromBase64(f.descriptors));
  return mat;
}

/** Number of RANSAC-consistent keypoint matches between two captures. */
export function countInliers(cv: CV, a: CardFeatures, b: CardFeatures): number {
  if (a.rows < 10 || b.rows < 10) return 0;
  const da = descriptorMat(cv, a);
  const db = descriptorMat(cv, b);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  try {
    matcher.knnMatch(da, db, knn, 2);
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() >= 2) {
        const best = pair.get(0);
        if (best.distance < RATIO_TEST * pair.get(1).distance) {
          src.push(a.points[best.queryIdx * 2], a.points[best.queryIdx * 2 + 1]);
          dst.push(b.points[best.trainIdx * 2], b.points[best.trainIdx * 2 + 1]);
        }
      }
      pair.delete();
    }
    const good = src.length / 2;
    if (good < MIN_INLIERS) return good; // can't reach the threshold; skip RANSAC

    const from = cv.matFromArray(good, 1, cv.CV_32FC2, src);
    const to = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
    const mask = new cv.Mat();
    const homography = cv.findHomography(from, to, cv.RANSAC, 5, mask);
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) inliers += mask.data[i] ? 1 : 0;
    from.delete();
    to.delete();
    mask.delete();
    homography.delete();
    return inliers;
  } finally {
    da.delete();
    db.delete();
    matcher.delete();
    knn.delete();
  }
}

export function isSameCard(cv: CV, a: CardFeatures, b: CardFeatures): boolean {
  const inliers = countInliers(cv, a, b);
  return inliers >= MIN_INLIERS && inliers / Math.min(a.rows, b.rows) >= MIN_INLIER_FRACTION;
}
