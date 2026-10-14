import { describe, expect, it } from "vitest";
import { StabilityTracker } from "@/lib/stability";
import type { Quad } from "@/lib/types";

// Card at ~50% of a 480x270 detection frame: ~97 x 135 px.
const card = (dx = 0, dy = 0): Quad => [
  { x: 190 + dx, y: 70 + dy },
  { x: 287 + dx, y: 70 + dy },
  { x: 287 + dx, y: 205 + dy },
  { x: 190 + dx, y: 205 + dy },
];

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2;
}

/** Simulated detections: hand tremor (shared offset) + per-corner noise, optional drift and dropouts. */
function sequence(seed: number, { shake = 0, drift = 0, dropout = 0, ticks = 40 } = {}) {
  const rnd = rng(seed);
  return Array.from({ length: ticks }, (_, t) => {
    if (Math.abs(rnd()) < dropout) return null;
    const base = card(rnd() * shake + drift * t, rnd() * shake);
    return base.map((p) => ({ x: p.x + rnd() * 2, y: p.y + rnd() * 2 })) as Quad;
  });
}

/** Fraction of 50 random runs in which the tracker locks within the sequence. */
function lockRate(opts: Parameters<typeof sequence>[1]) {
  let locked = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const tracker = new StabilityTracker();
    if (sequence(seed, opts).some((q) => tracker.update(q))) locked++;
  }
  return locked / 50;
}

describe("StabilityTracker", () => {
  it("locks a steady card", () => expect(lockRate({ shake: 0.5 })).toBe(1));
  it("locks through normal hand shake", () => expect(lockRate({ shake: 7 })).toBe(1));
  it("locks a shaky hand with detection dropouts", () => expect(lockRate({ shake: 8, dropout: 0.15 })).toBe(1));
  it("does not lock a card moving across the frame", () => expect(lockRate({ shake: 2, drift: 6 })).toBe(0));
  it("rarely locks a waved card", () => expect(lockRate({ shake: 30 })).toBeLessThanOrEqual(0.05));

  it("fires once per card and re-arms after the card leaves", () => {
    const tracker = new StabilityTracker();
    const fires = () => Array.from({ length: 20 }, () => tracker.update(card())).filter(Boolean).length;
    expect(fires()).toBe(1);
    expect(fires()).toBe(0); // still in frame: no repeat capture
    for (let i = 0; i < 6; i++) tracker.update(null);
    expect(fires()).toBe(1);
  });

  it("averages recent detections for a steadier crop", () => {
    const tracker = new StabilityTracker();
    tracker.update(card(-2, 0));
    tracker.update(card(2, 0));
    expect(tracker.smoothedQuad![0]).toEqual({ x: 190, y: 70 });
  });
});
