import { Redis } from "@upstash/redis";

export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);

/**
 * TTL cache. Backed by Upstash Redis when UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's
 * KV_REST_API_URL/TOKEN) are set, so every server instance shares it; otherwise an
 * in-memory map per process.
 */
export interface TtlCache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
}

type Entry<V> = { value: V; expiresAt: number };

export class MemoryTtlCache<V> implements TtlCache<V> {
  private entries = new Map<string, Entry<V>>();

  constructor(
    private ttlMs = CACHE_TTL_MS,
    private maxEntries = 5000,
  ) {}

  async get(key: string): Promise<V | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: V): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export class RedisTtlCache<V> implements TtlCache<V> {
  constructor(
    private redis: Redis,
    private prefix: string,
    private ttlMs = CACHE_TTL_MS,
  ) {}

  // Values are wrapped so a cached null ("looked up, nothing there") differs from a miss.
  async get(key: string): Promise<V | undefined> {
    try {
      const hit = await this.redis.get<{ v: V }>(this.prefix + key);
      return hit ? hit.v : undefined;
    } catch (err) {
      // A cache outage must never break a scan; treat it as a miss.
      console.warn("[cache] redis get failed:", err);
      return undefined;
    }
  }

  async set(key: string, value: V): Promise<void> {
    try {
      await this.redis.set(this.prefix + key, { v: value }, { px: this.ttlMs });
    } catch (err) {
      console.warn("[cache] redis set failed:", err);
    }
  }
}

let redisClient: Redis | null | undefined;

/** Shared Upstash client, or null when no Redis is configured. */
export function getRedis(): Redis | null {
  if (redisClient === undefined) {
    const configured =
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
    // One quick retry: the default (5 with exponential backoff) stalls a scan for ~4s
    // per cache call during an outage, and a miss is always an acceptable answer.
    redisClient = configured ? Redis.fromEnv({ retry: { retries: 1, backoff: () => 100 } }) : null;
  }
  return redisClient;
}

// Survive Next.js dev hot reloads by pinning caches to globalThis.
const globalCaches = globalThis as unknown as { __tcgCaches?: Map<string, TtlCache<unknown>> };
globalCaches.__tcgCaches ??= new Map();

/** Empty every in-memory named cache (used by tests). */
export function clearAllCaches(): void {
  for (const cache of globalCaches.__tcgCaches!.values()) if (cache instanceof MemoryTtlCache) cache.clear();
}

export function namedCache<V>(name: string): TtlCache<V> {
  let cache = globalCaches.__tcgCaches!.get(name);
  if (!cache) {
    const redis = getRedis();
    cache = redis ? new RedisTtlCache<unknown>(redis, `tcg:${name}:`) : new MemoryTtlCache<unknown>();
    globalCaches.__tcgCaches!.set(name, cache);
  }
  return cache as TtlCache<V>;
}
