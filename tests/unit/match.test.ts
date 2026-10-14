import { describe, expect, it } from "vitest";
import { normalizeNumber, rankCandidates, similarity, type Rankable } from "@/lib/catalog/match";

const card = (name: string, setName: string, number: string | null, extra: Partial<Rankable> = {}): Rankable & { id: string } => ({
  id: `${name}|${setName}|${number}`,
  name,
  setName,
  setCode: null,
  number,
  rarity: null,
  ...extra,
});

const reading = (title: string, extra: Partial<{ subtitle: string; setCode: string; number: string }> = {}) => ({
  title,
  subtitle: extra.subtitle ?? null,
  setCode: extra.setCode ?? null,
  number: extra.number ?? null,
});

describe("normalizeNumber", () => {
  it("strips totals and leading zeros", () => expect(normalizeNumber("045/271")).toBe("45"));
  it("keeps letter prefixes", () => expect(normalizeNumber("B048")).toBe("b048"));
});

describe("similarity", () => {
  it("is 1 for identical strings", () => expect(similarity("jackie welles", "jackie welles")).toBe(1));
  it("is high for small misreads", () => expect(similarity("mamas favorit", "mama s favorite")).toBeGreaterThan(0.7));
  it("is low for unrelated names", () => expect(similarity("counterspell", "jackie welles")).toBeLessThan(0.2));
});

describe("rankCandidates", () => {
  const bolts = [
    card("Lightning Bolt", "Magic 2011", "149", { setCode: "M11" }),
    card("Lightning Bolt", "Double Masters 2022", "117", { setCode: "2X2" }),
    card("Lightning Helix", "Ravnica", "213"),
  ];

  it("pins the printing by set code + number", () => {
    const r = rankCandidates(bolts, reading("Lightning Bolt", { setCode: "M11", number: "149/249" }));
    expect(r.decision).toBe("exact");
    expect(r.candidates[0].setName).toBe("Magic 2011");
    expect(r.candidates.every((c) => c.name === "Lightning Bolt")).toBe(true);
  });

  it("is ambiguous by name alone when there are reprints", () => {
    const r = rankCandidates(bolts, reading("Lightning Bolt"));
    expect(r.decision).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
    expect(r.exactName).toBe(true);
  });

  it("matches set codes inside set names like 'Magic 2011 (M11)'", () => {
    const cards = [card("Lightning Bolt", "Magic 2011 (M11)", "149"), card("Lightning Bolt", "Double Masters 2022 (2X2)", "149")];
    expect(rankCandidates(cards, reading("Lightning Bolt", { setCode: "2X2", number: "149" })).candidates[0].setName).toMatch(/2X2/);
  });

  it("matches either face of a double-faced card", () => {
    const cards = [card("Delver of Secrets // Insectile Aberration", "Innistrad", "51")];
    expect(rankCandidates(cards, reading("Insectile Aberration")).decision).toBe("exact");
  });

  it("falls back to close names when the title is misread", () => {
    const r = rankCandidates(bolts, reading("Lightnmg Bolt"));
    expect(r.candidates[0].name).toBe("Lightning Bolt");
    expect(r.exactName).toBe(false);
  });

  it("returns none when nothing is close", () => {
    expect(rankCandidates(bolts, reading("Black Lotus")).decision).toBe("none");
  });
});

describe("set name guess", () => {
  it("ranks the guessed set first when nothing pins the printing", () => {
    const counterspells = [
      card("Counterspell", "Foundations Commander", "61", { setCode: "FDC" }),
      card("Counterspell", "Secret Lair Drop", "7123", { setCode: "SLD" }),
      card("Counterspell", "Seventh Edition", "67", { setCode: "7ED" }),
    ];
    const r = rankCandidates(counterspells, { ...reading("Counterspell"), setNameGuess: "Seventh Edition" });
    expect(r.candidates[0].setCode).toBe("7ED");
    // A guess is a hint, not a reading: still ambiguous, so the second pass confirms it.
    expect(r.decision).toBe("ambiguous");
  });
});
