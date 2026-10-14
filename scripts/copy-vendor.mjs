// Copies pinned browser assets from node_modules into public/vendor (run before dev/build),
// so OpenCV.js is served by the app with long-lived cache headers instead of a CDN.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@techstark/opencv-js/package.json"), "utf8"));
const version = pkg.version.replace(/-release.*$/, "");
const out = path.join(root, "public/vendor");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, "node_modules/@techstark/opencv-js/dist/opencv.js"), path.join(out, `opencv-${version}.js`));
console.log(`public/vendor/opencv-${version}.js`);
