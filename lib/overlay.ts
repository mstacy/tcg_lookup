"use client";

import type { Point, Quad } from "./types";

const CARD_RATIO = 63 / 88;
const AMBER = "251, 191, 36";
const GREEN = "52, 211, 153";
const WHITE = "255, 255, 255";

export type OverlayState = {
  /** Latest detected quad, in video pixel coordinates. */
  quad: Quad | null;
  /** 0..1 progress toward a steady lock. */
  progress: number;
  locked: boolean;
  busy: boolean;
};

/**
 * Animated camera overlay, drawn every animation frame. A card-shaped guide shows
 * immediately (even before the detector loads); once a card is detected, an outline
 * glides to follow it and fills in as the hold-steady countdown progresses.
 */
export class OverlayRenderer {
  private shown: Point[] | null = null; // displayed corners, eased toward the target
  private lastQuad: Quad | null = null;
  private lastSeen = 0;
  private quadAlpha = 0;
  private guideAlpha = 1;

  constructor(private canvas: HTMLCanvasElement) {}

  draw(video: HTMLVideoElement | null, state: OverlayState, now: number) {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Map video pixels to screen pixels, accounting for `object-cover` cropping.
    const vw = video?.videoWidth ?? 0;
    const vh = video?.videoHeight ?? 0;
    const toScreen = (p: Point): Point => {
      const cover = Math.max(cw / vw, ch / vh);
      return { x: p.x * cover + (cw - vw * cover) / 2, y: p.y * cover + (ch - vh * cover) / 2 };
    };

    // Keep showing the last quad briefly through detection dropouts to avoid flicker.
    if (state.quad) {
      this.lastQuad = state.quad;
      this.lastSeen = now;
    }
    const target = vw && this.lastQuad && now - this.lastSeen < 400 ? this.lastQuad.map(toScreen) : null;

    this.quadAlpha = approach(this.quadAlpha, target ? 1 : 0, 0.25);
    this.guideAlpha = approach(this.guideAlpha, target ? 0 : 1, 0.15);

    if (this.guideAlpha > 0.01) this.drawGuide(ctx, cw, ch, now);

    if (target) {
      this.shown = this.shown
        ? this.shown.map((p, i) => ({ x: p.x + (target[i].x - p.x) * 0.45, y: p.y + (target[i].y - p.y) * 0.45 }))
        : target;
    }
    if (this.shown && this.quadAlpha > 0.01) this.drawQuad(ctx, this.shown, state, now);
    if (this.quadAlpha <= 0.01) this.shown = null;
  }

  private drawGuide(ctx: CanvasRenderingContext2D, cw: number, ch: number, now: number) {
    // Leave room for the hint pill (top) and the controls (bottom).
    const top = 56;
    const bottom = ch - 104;
    const h = Math.max(80, Math.min((bottom - top) * 0.92, (cw * 0.8) / CARD_RATIO));
    const w = h * CARD_RATIO;
    const x = (cw - w) / 2;
    const y = top + (bottom - top - h) / 2;
    const r = w * 0.05;
    const a = this.guideAlpha;

    // Dim everything outside the guide.
    ctx.save();
    ctx.fillStyle = `rgba(0, 0, 0, ${0.35 * a})`;
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.roundRect(x, y, w, h, r);
    ctx.fill("evenodd");
    ctx.restore();

    // Corner brackets, gently pulsing so it reads as "waiting for a card".
    const pulse = 0.65 + 0.35 * Math.sin(now / 450);
    const len = Math.min(w, h) * 0.18;
    ctx.strokeStyle = `rgba(${WHITE}, ${a * pulse})`;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x + w, y + h, -1, -1],
      [x, y + h, 1, -1],
    ]) {
      ctx.moveTo(cx, cy + dy * len);
      ctx.lineTo(cx, cy + dy * r);
      ctx.quadraticCurveTo(cx, cy, cx + dx * r, cy);
      ctx.lineTo(cx + dx * len, cy);
    }
    ctx.stroke();
  }

  private drawQuad(ctx: CanvasRenderingContext2D, q: Point[], state: OverlayState, now: number) {
    const a = this.quadAlpha;
    const path = new Path2D();
    q.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();

    ctx.save();
    ctx.lineJoin = "round";
    if (state.locked || state.busy) {
      // Locked: solid green, pulsing while the card is being identified.
      const pulse = state.busy ? 0.55 + 0.45 * Math.sin(now / 180) : 1;
      ctx.fillStyle = `rgba(${GREEN}, ${0.18 * a * pulse})`;
      ctx.fill(path);
      ctx.strokeStyle = `rgba(${GREEN}, ${a})`;
      ctx.lineWidth = 5;
      ctx.stroke(path);
    } else {
      // Tracking: amber outline, with green tracing around it as the hold-steady timer fills.
      ctx.fillStyle = `rgba(${AMBER}, ${0.1 * a})`;
      ctx.fill(path);
      ctx.strokeStyle = `rgba(${AMBER}, ${0.9 * a})`;
      ctx.lineWidth = 4;
      ctx.stroke(path);
      const perimeter = q.reduce((sum, p, i) => sum + Math.hypot(q[(i + 1) % 4].x - p.x, q[(i + 1) % 4].y - p.y), 0);
      if (state.progress > 0) {
        ctx.setLineDash([perimeter * state.progress, perimeter]);
        ctx.strokeStyle = `rgba(${GREEN}, ${a})`;
        ctx.lineWidth = 6;
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }
}

function approach(value: number, target: number, rate: number) {
  return value + (target - value) * rate;
}
