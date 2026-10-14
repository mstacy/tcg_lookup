export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);

/**
 * Minimal TTL cache. The in-memory implementation is per server process;
 * swap in a Redis/KV-backed implementation of this interface for persistence
 * across restarts or serverless instances.
 */
export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}

type Entry<V> = { value: V; expiresAt: number };

export class MemoryTtlCache<V> implements TtlCache<V> {
  private entries = new Map<string, Entry<V>>();

  constructor(
    private ttlMs = CACHE_TTL_MS,
    private maxEntries = 5000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

// Survive Next.js dev hot reloads by pinning caches to globalThis.
const globalCaches = globalThis as unknown as { __tcgCaches?: Map<string, MemoryTtlCache<unknown>> };
globalCaches.__tcgCaches ??= new Map();

export function namedCache<V>(name: string): TtlCache<V> {
  let cache = globalCaches.__tcgCaches!.get(name);
  if (!cache) {
    cache = new MemoryTtlCache<unknown>();
    globalCaches.__tcgCaches!.set(name, cache);
  }
  return cache as TtlCache<V>;
}
