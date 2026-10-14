/**
 * Web Worker running OpenCV card detection off the main thread, so parsing the 10 MB
 * library and per-frame detection never stall the UI or the overlay animation.
 * Classic worker (not a module) because OpenCV.js loads via importScripts.
 */
import { detectorOps, type DetectorOp, type DetectorOps } from "./detectorOps";
import { loadOpenCVInWorker } from "./opencv";

type Request = { id: number; op: "init"; origin: string } | { id: number; op: DetectorOp; args: unknown[] };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let ops: DetectorOps | null = null;

scope.onmessage = async (e) => {
  const req = e.data;
  try {
    if (req.op === "init") {
      ops ??= detectorOps(await loadOpenCVInWorker(req.origin));
      return scope.postMessage({ id: req.id, ok: true, result: null });
    }
    if (!ops) throw new Error("detector not initialised");
    const result = (ops[req.op] as (...a: unknown[]) => unknown)(...req.args);
    // Hand warped pixels back without copying.
    const transfer = result instanceof ImageData ? [result.data.buffer] : [];
    scope.postMessage({ id: req.id, ok: true, result }, transfer);
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
