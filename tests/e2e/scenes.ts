/**
 * Browser-side test helpers, bundled with esbuild and injected into Chrome by run.mjs:
 * synthetic card scenes (fake camera feeds) plus detector/matcher checks that need
 * OpenCV running in a real browser.
 */
import { detectCard, loadOpenCV, warpCard } from "../../lib/cardDetector";
import { countInliers, extractFeatures, isSameCard } from "../../lib/cardMatcher";
import type { Quad } from "../../lib/types";

/** Draw a fake card face. */
function cardFace(title: string, hue: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 630;
  c.height = 880;
  const g = c.getContext("2d")!;
  g.fillStyle = "#111";
  g.fillRect(0, 0, 630, 880);
  g.fillStyle = `hsl(${hue} 60% 55%)`;
  g.fillRect(30, 30, 570, 820);
  g.fillStyle = "#eee";
  g.fillRect(50, 50, 530, 60);
  g.fillStyle = "#000";
  g.font = "bold 40px serif";
  g.fillText(title, 65, 95);
  g.fillStyle = `hsl(${(hue + 120) % 360} 50% 35%)`;
  g.fillRect(50, 130, 530, 400);
  // Art and rules text seeded from the title, so different cards look different (like real ones).
  let seed = [...title].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 25; i++) {
    g.fillStyle = `hsl(${rnd() * 360} 70% ${30 + rnd() * 50}%)`;
    g.beginPath();
    g.ellipse(50 + rnd() * 530, 130 + rnd() * 400, 10 + rnd() * 60, 10 + rnd() * 60, rnd() * 3, 0, 7);
    g.fill();
  }
  g.fillStyle = "#f5f0e0";
  g.fillRect(50, 560, 530, 260);
  g.fillStyle = "#333";
  g.font = "24px serif";
  const words = ["Deal", "damage", "target", "draw", "card", "Flying", "counter", "spell", "each", "creature", "gains", "until", "end", "turn"];
  for (let i = 0; i < 5; i++) g.fillText(Array.from({ length: 6 }, () => words[Math.floor(rnd() * words.length)]).join(" "), 70, 610 + i * 40);
  return c;
}

/** Scene: cluttered dark background with the card rotated and scaled in. */
export type SceneOpts = { title?: string; hue?: number; angle?: number; jitter?: number; card?: boolean; w?: number; h?: number;
  scale?: number; rounded?: boolean; hand?: boolean; bg?: "wood" | "dark" | "light" | "busy"; noise?: number; glare?: boolean };
export function scene(opts: SceneOpts) {
  const { title = "Lightning Bolt", hue = 10, angle = 12, jitter = 0, card = true, w = 1280, h = 720,
    scale = 0.62, rounded = false, hand = false, bg = "wood", noise = 0, glare = false } = opts;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  const stops = { wood: ["#3a2f28", "#1d1915"], dark: ["#141414", "#0b0b0b"], light: ["#d8d4cc", "#bdb8ae"], busy: ["#556", "#223"] }[bg];
  grad.addColorStop(0, stops[0]);
  grad.addColorStop(1, stops[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // wood-grain-ish clutter
  g.strokeStyle = "rgba(255,255,255,0.05)";
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    g.moveTo(0, i * 18);
    g.bezierCurveTo(w / 3, i * 18 + 20, (2 * w) / 3, i * 18 - 20, w, i * 18);
    g.stroke();
  }
  if (bg === "busy") {
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `hsl(${(i * 47) % 360} 40% ${20 + ((i * 13) % 50)}%)`;
      g.fillRect((i * 97) % w, (i * 53) % h, 30 + ((i * 31) % 120), 20 + ((i * 17) % 90));
    }
  }
  let corners: { x: number; y: number }[] = [];
  if (card) {
    const cw = scale * h * (63 / 88);
    const ch = scale * h;
    const cx = w / 2 + jitter;
    const cy = h / 2 - jitter / 2;
    const a = (angle * Math.PI) / 180;
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    if (rounded) {
      g.beginPath();
      g.roundRect(-cw / 2, -ch / 2, cw, ch, cw * 0.05);
      g.clip();
    }
    g.drawImage(cardFace(title, hue), -cw / 2, -ch / 2, cw, ch);
    if (glare) {
      const gl = g.createRadialGradient(cw * 0.15, -ch * 0.1, 5, cw * 0.15, -ch * 0.1, cw * 0.45);
      gl.addColorStop(0, "rgba(255,255,255,0.85)");
      gl.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gl;
      g.fillRect(-cw / 2, -ch / 2, cw, ch);
    }
    g.restore();
    if (hand) {
      // thumb over the left edge and fingers behind/below the bottom edge
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.fillStyle = "#c98f6b";
      g.beginPath();
      g.ellipse(-cw / 2, ch * 0.1, cw * 0.14, ch * 0.09, 0.3, 0, 7);
      g.fill();
      g.beginPath();
      g.ellipse(-cw * 0.1, ch / 2 + ch * 0.05, cw * 0.35, ch * 0.09, 0, 0, 7);
      g.fill();
      g.fillRect(-cw * 0.45, ch / 2, cw * 0.7, h);
      g.restore();
    }
    corners = [
      [-cw / 2, -ch / 2],
      [cw / 2, -ch / 2],
      [cw / 2, ch / 2],
      [-cw / 2, ch / 2],
    ].map(([x, y]) => ({ x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) }));
  }
  if (noise) {
    const img = g.getImageData(0, 0, w, h);
    let seed = 12345;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = ((seed / 2 ** 32) - 0.5) * noise * 2;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }
  return { canvas: c, corners };
}

function downscale(src: HTMLCanvasElement, width: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round((src.height / src.width) * width);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function filtered(src: HTMLCanvasElement, filter: string) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d")!;
  g.filter = filter;
  g.drawImage(src, 0, 0);
  return c;
}

/** JPEG frames (base64) for a fake camera feed; alternating 1px jitter like a held card. */
function makeFrames(count: number, opts: SceneOpts = {}): string[] {
  return Array.from({ length: count }, (_, i) => scene({ angle: 8, ...opts, jitter: i % 2 }).canvas.toDataURL("image/jpeg", 0.9).split(",")[1]);
}

/** Detection and same-card matching checks; returns named results for assertions in Node. */
async function detectorChecks() {
  const cv = await loadOpenCV();
  const k = 1280 / 480;
  const detect = (opts: SceneOpts) => {
    const { canvas, corners } = scene(opts);
    const quad = detectCard(cv, downscale(canvas, 480));
    if (!corners.length) return { found: !!quad, err: null };
    const diag = Math.hypot(corners[0].x - corners[2].x, corners[0].y - corners[2].y);
    const err = quad ? Math.max(...quad.map((p) => Math.min(...corners.map((c) => Math.hypot(p.x * k - c.x, p.y * k - c.y))))) / diag : null;
    return { found: !!quad, err };
  };
  const featuresOf = (canvas: HTMLCanvasElement) => {
    const quad = detectCard(cv, downscale(canvas, 480))!;
    return extractFeatures(cv, warpCard(cv, canvas, quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad));
  };
  const base = JSON.parse(JSON.stringify(featuresOf(scene({ angle: 12 }).canvas))); // localStorage round-trip
  const same = (canvas: HTMLCanvasElement) => isSameCard(cv, featuresOf(canvas), base);

  return {
    detect: {
      angle0: detect({ angle: 0 }),
      angle25: detect({ angle: -25 }),
      landscape: detect({ angle: 90 }),
      rounded: detect({ rounded: true }),
      small: detect({ rounded: true, scale: 0.35 }),
      noise: detect({ rounded: true, noise: 12 }),
      glare: detect({ rounded: true, glare: true }),
      empty: detect({ card: false }),
      // Known limitation: fingers across the edge. Must not produce a wrong quad.
      hand: detect({ rounded: true, hand: true }),
    },
    sameCard: {
      shifted: same(scene({ angle: 14, jitter: 6 }).canvas),
      landscape: same(scene({ angle: 90 }).canvas),
      contrast: same(filtered(scene({ angle: 10 }).canvas, "brightness(1.2) contrast(1.2)")),
      blur: same(filtered(scene({ angle: 12 }).canvas, "blur(1.5px)")),
    },
    differentCard: {
      helix: same(scene({ angle: 12, title: "Lightning Helix" }).canvas),
      counterspell: same(scene({ angle: 12, title: "Counterspell", hue: 210 }).canvas),
    },
    inliersSame: countInliers(cv, featuresOf(scene({ angle: 14 }).canvas), base),
  };
}

Object.assign(window, { makeFrames, detectorChecks });
