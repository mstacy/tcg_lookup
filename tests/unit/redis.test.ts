/**
 * The shared-cache path: Upstash Redis (mocked at its REST protocol), the shared rate
 * limiter, and the daily price-refresh cron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUSTTCG_CARDS } from "./mockApis";

type Store = Map<string, { value: string | number; expiresAt: number | null }>;
let store: Store;
let redisDown = false;
let justtcgCalls: string[] = [];

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

type Command = [string, string, ...(string | number)[]];

/** Minimal Redis semantics for the commands the app uses; string replies are base64 like Upstash's. */
function exec([cmd, key, ...args]: Command): unknown {
  const now = Date.now();
  const live = store.get(key);
  if (live?.expiresAt && live.expiresAt <= now) store.delete(key);
  switch (cmd.toLowerCase()) {
    case "get": {
      const v = store.get(key)?.value;
      return v === undefined ? null : b64(String(v));
    }
    case "set": {
      const px = args[1] === "px" ? Number(args[2]) : null;
      store.set(key, { value: String(args[0]), expiresAt: px ? now + px : null });
      return "OK";
    }
    case "incr": {
      const n = Number(store.get(key)?.value ?? 0) + 1;
      store.set(key, { value: n, expiresAt: store.get(key)?.expiresAt ?? null });
      return n;
    }
    case "pexpire": {
      const e = store.get(key);
      if (e) e.expiresAt = now + Number(args[0]);
      return e ? 1 : 0;
    }
  }
  throw new Error(`unmocked redis command ${cmd}`);
}

function installMocks() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "redis.test") {
      if (redisDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init!.body));
      // The client auto-pipelines: POST /pipeline with [[cmd, ...args], ...].
      if (url.pathname === "/pipeline") return Response.json((body as Command[]).map((c) => ({ result: exec(c) })));
      return Response.json({ result: exec(body as Command) });
    }
    if (url.host === "api.justtcg.com") {
      justtcgCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const ids = (JSON.parse(String(init?.body ?? "[]")) as { cardId: string }[]).map((i) => i.cardId);
      const data = ids.map((id) => JUSTTCG_CARDS.find((c) => c.id === id) ?? { id, name: id, variants: [{ condition: "Near Mint", printing: "Foil", language: "English", price: 3, lastUpdated: 1 }] });
      return Response.json({ data });
    }
    throw new Error(`Unmocked request: ${url}`);
  });
}

/** Fresh module graph, as if on a new server instance (caches and Redis client rebuilt). */
async function freshInstance() {
  vi.resetModules();
  (globalThis as { __tcgCaches?: unknown }).__tcgCaches = undefined;
  return {
    cache: await import("@/lib/cache"),
    rateLimit: await import("@/lib/rateLimit"),
    snapshot: await import("@/lib/catalog/snapshot"),
    cron: await import("@/app/api/cron/refresh-prices/route"),
  };
}

beforeEach(() => {
  store = new Map();
  redisDown = false;
  justtcgCalls = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  process.env.JUSTTCG_API_KEY = "test-key";
  process.env.CRON_SECRET = "s3cret";
  installMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  vi.resetModules();
  (globalThis as { __tcgCaches?: unknown }).__tcgCaches = undefined;
});

describe("Redis-backed cache", () => {
  it("is shared across server instances", async () => {
    const a = await freshInstance();
    await a.cache.namedCache<{ price: number }>("test").set("bolt", { price: 1.21 });
    const b = await freshInstance();
    expect(await b.cache.namedCache<{ price: number }>("test").get("bolt")).toEqual({ price: 1.21 });
  });

  it("distinguishes a cached null from a miss", async () => {
    const { cache } = await freshInstance();
    const c = cache.namedCache<string | null>("test");
    await c.set("nothing-there", null);
    expect(await c.get("nothing-there")).toBeNull();
    expect(await c.get("never-set")).toBeUndefined();
  });

  it("treats a Redis outage as a miss instead of failing", async () => {
    const { cache } = await freshInstance();
    redisDown = true;
    const c = cache.namedCache<number>("test");
    await expect(c.set("x", 1)).resolves.toBeUndefined();
    expect(await c.get("x")).toBeUndefined();
  });

  it("uses memory when Redis isn't configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const { cache } = await freshInstance();
    expect(cache.getRedis()).toBeNull();
    const c = cache.namedCache<number>("test");
    await c.set("x", 1);
    expect(await c.get("x")).toBe(1);
    expect(store.size).toBe(0);
  });
});

describe("shared rate limiter", () => {
  it("allows 20 requests per minute per IP across instances", async () => {
    const a = await freshInstance();
    for (let i = 0; i < 10; i++) expect(await a.rateLimit.allowRequest("1.2.3.4")).toBe(true);
    const b = await freshInstance();
    for (let i = 0; i < 10; i++) expect(await b.rateLimit.allowRequest("1.2.3.4")).toBe(true);
    expect(await b.rateLimit.allowRequest("1.2.3.4")).toBe(false);
    expect(await b.rateLimit.allowRequest("5.6.7.8")).toBe(true);
  });

  it("fails open when Redis is down", async () => {
    const { rateLimit } = await freshInstance();
    redisDown = true;
    expect(await rateLimit.allowRequest("1.2.3.4")).toBe(true);
  });
});

describe("daily price refresh cron", () => {
  const call = async (cron: Awaited<ReturnType<typeof freshInstance>>["cron"], auth?: string) => {
    const { NextRequest } = await import("next/server");
    return cron.GET(new NextRequest("http://localhost/api/cron/refresh-prices", { headers: auth ? { authorization: auth } : {} }));
  };

  it("rejects requests without the cron secret", async () => {
    const { cron } = await freshInstance();
    expect((await call(cron)).status).toBe(401);
    expect((await call(cron, "Bearer wrong")).status).toBe(401);
    expect(justtcgCalls).toHaveLength(0);
  });

  it("prices whole snapshot games in batches, then scans on any instance cost nothing", async () => {
    const { cron } = await freshInstance();
    const res = await call(cron, "Bearer s3cret");
    expect(res.status).toBe(200);
    expect((await res.json()).refreshed["cyberpunk-tcg"]).toBe(453);
    expect(justtcgCalls).toEqual(["POST /v1/cards", "POST /v1/cards", "POST /v1/cards"]);

    const other = await freshInstance();
    const printings = other.snapshot.snapshotPrintings("cyberpunk-tcg").slice(0, 3);
    const { printings: priced } = await other.snapshot.priceSnapshotPrintings("cyberpunk-tcg", printings);
    expect(justtcgCalls).toHaveLength(3);
    expect(priced.every((p) => p.priceAsOf === null)).toBe(true);
  });
});
