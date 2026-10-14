import { getRedis } from "./cache";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20);

const hits = new Map<string, number[]>();

/** Sliding window in this process only (fallback when no Redis is configured). */
function allowInMemory(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  const allowed = recent.length < MAX_REQUESTS;
  if (allowed) recent.push(now);
  hits.set(ip, recent);
  return allowed;
}

/**
 * Per-IP limit on model-backed requests. With Redis it's a fixed one-minute window
 * shared by every server instance; otherwise per process. Returns true if allowed.
 */
export async function allowRequest(ip: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return allowInMemory(ip);
  const key = `tcg:rl:${ip}:${Math.floor(Date.now() / WINDOW_MS)}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, WINDOW_MS + 10_000);
    return count <= MAX_REQUESTS;
  } catch (err) {
    // Fail open on a Redis outage rather than blocking every scan.
    console.warn("[rateLimit] redis failed:", err);
    return allowInMemory(ip);
  }
}
