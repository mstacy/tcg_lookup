import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveCandidates } from "@/lib/catalog";
import { priceMatch, refinePrice } from "@/lib/pricing";
import { ident, installMockApis, resetCaches, type MockState } from "./mockApis";

let api: MockState;
const justtcgCalls = () => api.calls.filter((c) => c.startsWith("justtcg"));

beforeEach(() => {
  resetCaches();
  api = installMockApis();
  process.env.JUSTTCG_API_KEY = "test-key";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

async function priced(game: string, title: string, extra: Parameters<typeof ident>[2] = {}) {
  const { gameId, ranked } = await retrieveCandidates(ident(game, title, extra));
  return priceMatch(gameId, ranked.candidates);
}

describe("Magic", () => {
  it("prices the top printing per condition via JustTCG (English only) with one request", async () => {
    const { printings, error } = await priced("MTG", "Lightning Bolt", { setCode: "M11", collectorNumber: "149" });
    expect(error).toBeNull();
    expect(printings[0].priceSource).toBe("JustTCG");
    expect(new Set(printings[0].variants.map((v) => v.condition)).size).toBe(5);
    expect(printings[0].variants.every((v) => !v.printing.includes("French"))).toBe(true);
    expect(justtcgCalls()).toHaveLength(1);
  });

  it("leaves other printings on Scryfall prices, refinable on demand", async () => {
    const { printings } = await priced("MTG", "Lightning Bolt");
    expect(printings.slice(1).every((p) => p.priceSource?.startsWith("Scryfall") && p.canRefinePrice)).toBe(true);
    const refined = await refinePrice({ scryfallId: "sf-2x2-bolt" });
    expect(refined?.variants.length).toBeGreaterThan(2);
  });

  it("caches per-printing prices for 24h", async () => {
    await refinePrice({ scryfallId: "sf-m11-bolt" });
    await refinePrice({ scryfallId: "sf-m11-bolt" });
    expect(justtcgCalls()).toHaveLength(1);
  });

  it("keeps Scryfall's Near Mint price on a rate limit", async () => {
    api.justtcg = "429";
    const { printings, error } = await priced("MTG", "Lightning Bolt", { setCode: "M11", collectorNumber: "149" });
    expect(printings[0].priceSource).toMatch(/Scryfall/);
    expect(printings[0].variants.map((v) => v.price)).toEqual([1.21, 7.59]);
    expect(error).toBeNull();
  });

  it("uses Scryfall prices without a JustTCG key", async () => {
    delete process.env.JUSTTCG_API_KEY;
    const { printings } = await priced("MTG", "Lightning Bolt", { setCode: "M11", collectorNumber: "149" });
    expect(printings[0].priceSource).toMatch(/Scryfall/);
    expect(justtcgCalls()).toHaveLength(0);
  });
});

describe("Cyberpunk TCG (snapshot)", () => {
  it("prices a scan's candidates in one batch request, then repeat scans cost nothing", async () => {
    const { printings } = await priced("Cyberpunk TCG", "Jackie Welles");
    expect(justtcgCalls()).toEqual([expect.stringMatching(/^justtcg POST \/v1\/cards/)]);
    expect(printings.length).toBeGreaterThan(3);
    expect(printings.every((x) => x.priceAsOf === null)).toBe(true); // fresh prices, not the snapshot's
    await priced("Cyberpunk TCG", "Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "007" });
    expect(justtcgCalls()).toHaveLength(1); // its candidate was already priced today
  });

  it("never sends more than 20 cards per batch (free-plan limit)", async () => {
    const { cardsByIds } = await import("@/lib/pricing/justtcg");
    const sizes: number[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") sizes.push(JSON.parse(String(init.body)).length);
      return realFetch(input, init);
    });
    await cardsByIds(Array.from({ length: 45 }, (_, i) => `card-${i}`));
    expect(sizes).toEqual([20, 20, 5]);
  });

  it("falls back to the snapshot's prices, labeled with their date, when JustTCG fails", async () => {
    api.justtcg = "429";
    const { printings } = await priced("Cyberpunk TCG", "Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "007" });
    expect(printings[0].priceAsOf).toBeGreaterThan(0);
    expect(printings[0].variants.length).toBeGreaterThan(0);
  });
});
