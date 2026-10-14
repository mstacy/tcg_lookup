/**
 * Loading OpenCV.js, in a page (script tag) or a classic Web Worker (importScripts).
 * Served from /vendor (copied from node_modules by scripts/copy-vendor.mjs) with
 * long-lived cache headers; NEXT_PUBLIC_OPENCV_URL overrides it.
 */

// OpenCV.js has no bundled types; keep `any` contained to the detector modules.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type CV = any;

export const OPENCV_PATH = process.env.NEXT_PUBLIC_OPENCV_URL ?? "/vendor/opencv-4.10.0.js";

/**
 * Wait for the Emscripten module to be ready. It has its own `then`; resolving a
 * Promise with it makes the Promise adopt it as a thenable and never settle, so
 * `then` is stripped first.
 */
function whenReady(cv: CV): Promise<CV> {
  return new Promise((resolve, reject) => {
    const ready = (mod: CV) => {
      if (Object.prototype.hasOwnProperty.call(mod, "then")) delete mod.then;
      resolve(mod);
    };
    if (cv instanceof Promise) cv.then(ready, reject);
    else if (cv?.Mat) ready(cv);
    else if (cv) cv.onRuntimeInitialized = () => ready(cv);
    else reject(new Error("OpenCV.js loaded but `cv` is missing."));
  });
}

let pagePromise: Promise<CV> | null = null;

/** Load OpenCV into the page (fallback when Web Workers aren't available). */
export function loadOpenCVInPage(): Promise<CV> {
  if (pagePromise) return pagePromise;
  pagePromise = new Promise<CV>((resolve, reject) => {
    const win = window as any;
    const done = () =>
      whenReady(win.cv).then((mod) => {
        win.cv = mod;
        resolve(mod);
      }, reject);
    if (win.cv) return done();
    const script = document.createElement("script");
    script.src = OPENCV_PATH;
    script.async = true;
    script.onload = done;
    script.onerror = () => reject(new Error("Failed to load OpenCV.js."));
    document.head.appendChild(script);
  });
  pagePromise.catch(() => (pagePromise = null));
  return pagePromise;
}

/** Load OpenCV inside a classic Web Worker. `origin` resolves the script path. */
export async function loadOpenCVInWorker(origin: string): Promise<CV> {
  const scope = globalThis as any;
  scope.importScripts(new URL(OPENCV_PATH, origin).href);
  const mod = await whenReady(scope.cv);
  scope.cv = mod;
  return mod;
}
