/**
 * Cheap 64-bit difference hash, used only to order cached scans so the likeliest
 * candidates get the (slower, reliable) ORB match in cardMatcher.ts first.
 * Hash distance alone can't separate same/different cards: crop jitter between
 * captures of one card moves as many bits as a different card does.
 */
export const HASH_SIZE = 8;

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += POPCOUNT_NIBBLE[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return distance;
}

/**
 * Difference hash (dHash) of an image, as hex. Browser only.
 * Shrinks to (size+1) x size grayscale and records whether each pixel is brighter
 * than its right neighbour, which is robust to small shifts, scaling and exposure.
 */
export function dHash(source: CanvasImageSource, size = HASH_SIZE): string {
  const w = size + 1;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, size);
  const { data } = ctx.getImageData(0, 0, w, size);

  const gray = new Float32Array(w * size);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }

  let hex = "";
  let nibble = 0;
  let bits = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      nibble = (nibble << 1) | (gray[row * w + col] > gray[row * w + col + 1] ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}
