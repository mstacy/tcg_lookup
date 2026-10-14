import type { Point, Quad } from "./types";

/** Detection ticks considered (~0.75 s at 150 ms per tick). */
const WINDOW = 5;
/** Ticks in the window that must contain a detection (tolerates brief dropouts from blur). */
const MIN_DETECTIONS = 4;
/**
 * Max distance of any corner from the window's average corner, as a fraction of the
 * card's diagonal. Measured against the average (not the previous frame), so hand
 * shake that jitters around one spot counts as steady, while real movement doesn't.
 */
const MAX_DEVIATION = 0.07;
/** Max net movement between the older and newer halves of the window (same units). */
const MAX_DRIFT = 0.05;
const REARM_EMPTY_FRAMES = 6;

function averageQuad(quads: Quad[]): Quad {
  return [0, 1, 2, 3].map((i) => ({
    x: quads.reduce((sum, q) => sum + q[i].x, 0) / quads.length,
    y: quads.reduce((sum, q) => sum + q[i].y, 0) / quads.length,
  })) as Quad;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Decides when a detected card has been held steady enough to auto-capture.
 * Fires once per card: after firing, it re-arms only when the card has left
 * the frame for a few detection ticks.
 */
export class StabilityTracker {
  private window: (Quad | null)[] = [];
  private emptyCount = 0;
  private armed = true;
  private steadyTicks = 0;

  /** Returns true exactly once when a held-steady card should be captured. */
  update(quad: Quad | null): boolean {
    this.window.push(quad);
    if (this.window.length > WINDOW) this.window.shift();

    if (quad) this.emptyCount = 0;
    else if (++this.emptyCount >= REARM_EMPTY_FRAMES) this.armed = true;

    this.steadyTicks = this.countSteady();
    if (this.armed && this.steadyTicks >= MIN_DETECTIONS) {
      this.armed = false;
      return true;
    }
    return false;
  }

  /** How many quads in the window agree with their average (0 if they don't all agree). */
  private countSteady(): number {
    const quads = this.window.filter((q): q is Quad => q !== null);
    if (quads.length < 2) return quads.length;
    const mean = averageQuad(quads);
    const tolerance = dist(mean[0], mean[2]) * MAX_DEVIATION;
    const steady = quads.every((q) => q.every((p, i) => dist(p, mean[i]) <= tolerance));
    if (!steady) return 0;

    // Shake jitters around a point; a sliding card drifts one way. Compare the average
    // position in the older half of the window against the newer half.
    const half = Math.floor(quads.length / 2);
    const older = averageQuad(quads.slice(0, half));
    const newer = averageQuad(quads.slice(quads.length - half));
    const drift = older.reduce((sum, p, i) => sum + dist(p, newer[i]), 0) / 4;
    return drift <= dist(mean[0], mean[2]) * MAX_DRIFT ? quads.length : 0;
  }

  /** Average of the recent detections; steadier than the latest quad for cropping. */
  get smoothedQuad(): Quad | null {
    const quads = this.window.filter((q): q is Quad => q !== null);
    return quads.length ? averageQuad(quads) : null;
  }

  /** 0..1 progress toward a steady lock, for UI feedback. */
  get progress(): number {
    return this.armed ? Math.min(1, this.steadyTicks / MIN_DETECTIONS) : 1;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  reset(): void {
    this.window = [];
    this.emptyCount = 0;
    this.steadyTicks = 0;
    this.armed = true;
  }
}
