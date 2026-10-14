import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveCandidates } from "@/lib/catalog";
import { gameId } from "@/lib/catalog/games";
import { ident, installMockApis, resetCaches, type MockState } from "./mockApis";

let api: MockState;

beforeEach(() => {
  resetCaches();
  api = installMockApis();
  process.env.JUSTTCG_API_KEY = "test-key";
});
afterEach(() => vi.unstubAllGlobals());

describe("gameId", () => {
  it("maps names and aliases to JustTCG ids", () => {
    expect(gameId("Magic: The Gathering")).toBe("magic-the-gathering");
    expect(gameId("MTG")).toBe("magic-the-gathering");
    expect(gameId("Cyberpunk 2077 TCG")).toBe("cyberpunk-tcg");
    expect(gameId("Pokémon")).toBe("pokemon");
    expect(gameId("Netrunner")).toBeNull();
  });
});

describe("Cyberpunk TCG (real catalog snapshot, no network)", () => {
  const cp = (title: string, extra: Parameters<typeof ident>[2] = {}) => retrieveCandidates(ident("Cyberpunk TCG", title, extra));

  it("pins name + subtitle + number to one printing", async () => {
    const { ranked } = await cp("Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "007" });
    expect(ranked.decision).toBe("exact");
    expect(ranked.candidates[0]).toMatchObject({ name: "Jackie Welles - Mama's Favorite", setName: "Pre-Release Beta", number: "007" });
    expect(api.calls).toHaveLength(0);
  });

  it("tells Beta (B073) and Retail (073) printings apart by number", async () => {
    const beta = await cp("Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "B073" });
    const retail = await cp("Jackie Welles", { subtitle: "Mama's Favorite", collectorNumber: "073" });
    expect(beta.ranked.candidates[0].setName).toMatch(/Beta/);
    expect(retail.ranked.candidates[0].setName).toMatch(/Retail/);
  });

  it("is ambiguous without a number, with every Jackie Welles printing as a candidate", async () => {
    const { ranked } = await cp("Jackie Welles");
    expect(ranked.decision).toBe("ambiguous");
    expect(ranked.exactName).toBe(true);
    expect(ranked.candidates.length).toBeGreaterThan(3);
    expect(ranked.candidates.every((c) => c.name.startsWith("Jackie Welles"))).toBe(true);
  });

  it("puts the right card in the top 3 when the subtitle is misread", async () => {
    const { ranked } = await cp("Jackie Welles", { subtitle: "Mamas Favorit" });
    expect(ranked.candidates.slice(0, 3).some((c) => c.name.startsWith("Jackie Welles - Mama's Favorite"))).toBe(true);
    expect(ranked.exactName).toBe(false);
  });
});

describe("Magic (Scryfall)", () => {
  it("returns the exact printing for a legible set code + number", async () => {
    const { ranked, catalog } = await retrieveCandidates(ident("MTG", "Lightning Bolt", { setCode: "M11", collectorNumber: "149/249" }));
    expect(catalog).toBe("Scryfall");
    expect(ranked.decision).toBe("exact");
    expect(ranked.candidates[0]).toMatchObject({ setCode: "M11", number: "149", scryfallId: "sf-m11-bolt" });
  });

  it("returns every printing (no 20-result cap) when only the name is read", async () => {
    const { ranked } = await retrieveCandidates(ident("MTG", "Lightning Bolt"));
    expect(ranked.decision).toBe("ambiguous");
    expect(ranked.candidates.map((c) => c.setCode).sort()).toEqual(["2X2", "M11", "MSC"]);
    expect(api.calls.some((c) => c.includes("unique=prints"))).toBe(true);
  });

  it("ignores a misread number rather than returning the wrong card", async () => {
    const { ranked } = await retrieveCandidates(ident("MTG", "Lightning Bolt", { setCode: "M11", collectorNumber: "150" }));
    expect(ranked.decision).toBe("ambiguous");
  });

  it("caches Scryfall lookups", async () => {
    await retrieveCandidates(ident("MTG", "Lightning Bolt"));
    const n = api.calls.length;
    await retrieveCandidates(ident("MTG", "Lightning Bolt"));
    expect(api.calls.length).toBe(n);
  });
});

it("explains games without a catalog", async () => {
  await expect(retrieveCandidates(ident("Netrunner", "Gordian Blade"))).rejects.toThrow(/No card catalog for Netrunner/);
});
