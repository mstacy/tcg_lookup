import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPricing } from "@/lib/pricing";
import { verifyCard } from "@/lib/verify";
import { ident, installMockApis, resetCaches, type MockState } from "./mockApis";

let api: MockState;
const justtcgCalls = () => api.calls.filter((c) => c.startsWith("justtcg"));

beforeEach(() => {
  resetCaches();
  api = installMockApis();
  process.env.JUSTTCG_API_KEY = "test-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

const bolt = ident("Magic: The Gathering", "Lightning Bolt", { setCode: "M11", collectorNumber: "149/249" });
const verifyBolt = () => verifyCard(bolt.game, bolt.title, { hints: { setCode: bolt.setCode, collectorNumber: bolt.collectorNumber } });

describe("Magic", () => {
  it("prices the exact printing read off the card with one request", async () => {
    const v = await verifyBolt();
    expect(v?.exactPrinting).toBe(true);
    const { pricing } = await getPricing(bolt, v);
    expect(pricing?.source).toBe("JustTCG");
    expect(pricing?.confident).toBe(true);
    expect(pricing?.printings[0].setName).toBe("Magic 2011 (M11)");
    // English variants only
    expect(pricing?.printings[0].variants.every((x) => !x.printing.includes("French"))).toBe(true);
    expect(justtcgCalls()).toHaveLength(1);
  });

  it("serves a repeat scan from the 24h cache, and fresh bypasses it", async () => {
    const v = await verifyBolt();
    await getPricing(bolt, v);
    await getPricing(bolt, v);
    expect(justtcgCalls()).toHaveLength(1);
    await getPricing(bolt, v, { fresh: true });
    expect(justtcgCalls()).toHaveLength(2);
  });

  it("falls back to Scryfall's Near Mint price without a JustTCG key", async () => {
    delete process.env.JUSTTCG_API_KEY;
    const { pricing } = await getPricing(bolt, await verifyBolt());
    expect(pricing?.source).toMatch(/Scryfall/);
    expect(pricing?.printings[0].variants.map((x) => x.price)).toEqual([1.21, 7.59]);
  });

  it("falls back to Scryfall on a rate limit and doesn't cache the failure", async () => {
    const v = await verifyBolt();
    api.justtcg = "429";
    expect((await getPricing(bolt, v)).pricing?.source).toMatch(/Scryfall/);
    api.justtcg = "ok";
    expect((await getPricing(bolt, v)).pricing?.source).toBe("JustTCG");
  });

  it("marks a name-only match as uncertain", async () => {
    const id = ident("MTG", "Lightning Bolt");
    const v = await verifyCard(id.game, id.title, { hints: {} });
    expect(v?.exactPrinting).toBe(false);
    const { pricing } = await getPricing(id, v);
    expect(pricing?.confident).toBe(false);
    expect(pricing?.printings.length).toBeGreaterThan(1);
  });
});

describe("Cyberpunk TCG", () => {
  it("matches name + subtitle + number exactly", async () => {
    const { pricing } = await getPricing(ident("Cyberpunk TCG", "Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "007" }), null);
    expect(pricing?.printings[0].id).toBe("cp-jackie-mama");
    expect(pricing?.confident).toBe(true);
    expect(pricing?.exactName).toBe(true);
  });

  it("ranks the closest name first when the subtitle is misread", async () => {
    const { pricing } = await getPricing(ident("Cyberpunk TCG", "Jackie Welles", { subtitle: "Mamas Favorit" }), null);
    expect(pricing?.printings[0].name).toMatch(/Mama's Favorite/);
    expect(pricing?.exactName).toBe(false);
    expect(pricing?.confident).toBe(false);
  });

  it("explains missing pricing without a key", async () => {
    delete process.env.JUSTTCG_API_KEY;
    const r = await getPricing(ident("Cyberpunk TCG", "Jackie Welles"), null);
    expect(r.pricing).toBeNull();
    expect(r.error).toMatch(/JUSTTCG_API_KEY/);
  });

  it("reports a rate limit", async () => {
    api.justtcg = "429";
    const r = await getPricing(ident("Cyberpunk TCG", "Jackie Welles"), null);
    expect(r.error).toMatch(/rate limit/);
  });
});

it("says when JustTCG doesn't cover a game", async () => {
  const r = await getPricing(ident("Netrunner", "Gordian Blade"), null);
  expect(r.error).toMatch(/doesn't cover Netrunner/);
});
