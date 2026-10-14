"use client";

import type { CardFeatures } from "./cardMatcher";
import { detectorOps, type Detection, type DetectorOp } from "./detectorOps";
import { loadOpenCVInPage } from "./opencv";
import type { Quad } from "./types";

export type { Detection };

/** Async card-detection API; backed by a Web Worker when possible. */
export interface Detector {
  /** "worker" or "main thread", for diagnostics. */
  readonly mode: string;
  detect(image: ImageData): Promise<Detection | null>;
  warp(image: ImageData, quad: Quad): Promise<ImageData>;
  features(image: ImageData): Promise<CardFeatures>;
  match(features: CardFeatures, candidates: CardFeatures[]): Promise<number>;
}

class WorkerDetector implements Detector {
  readonly mode = "worker";
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private worker: Worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  call<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  private op<T>(op: DetectorOp, args: unknown[], transfer: Transferable[] = []) {
    return this.call<T>({ op, args }, transfer);
  }

  // Frames are transferred, not copied; callers must not reuse an ImageData they pass in.
  detect(image: ImageData) {
    return this.op<Detection | null>("detect", [image], [image.data.buffer]);
  }
  warp(image: ImageData, quad: Quad) {
    return this.op<ImageData>("warp", [image, quad], [image.data.buffer]);
  }
  features(image: ImageData) {
    return this.op<CardFeatures>("features", [image]);
  }
  match(features: CardFeatures, candidates: CardFeatures[]) {
    return this.op<number>("match", [features, candidates]);
  }
}

class InlineDetector implements Detector {
  readonly mode = "main thread";
  constructor(private ops: ReturnType<typeof detectorOps>) {}
  async detect(image: ImageData) {
    return this.ops.detect(image);
  }
  async warp(image: ImageData, quad: Quad) {
    return this.ops.warp(image, quad);
  }
  async features(image: ImageData) {
    return this.ops.features(image);
  }
  async match(features: CardFeatures, candidates: CardFeatures[]) {
    return this.ops.match(features, candidates);
  }
}

let detectorPromise: Promise<Detector> | null = null;

/** Start the detector once: a Web Worker if it loads, else OpenCV on the main thread. */
export function getDetector(): Promise<Detector> {
  detectorPromise ??= (async () => {
    try {
      const worker = new Worker(new URL("./detector.worker.ts", import.meta.url));
      const detector = new WorkerDetector(worker);
      await detector.call({ op: "init", origin: location.origin });
      return detector;
    } catch (err) {
      console.warn("Detector worker unavailable, using the main thread:", err);
      return new InlineDetector(detectorOps(await loadOpenCVInPage()));
    }
  })();
  detectorPromise.catch(() => (detectorPromise = null));
  return detectorPromise;
}
