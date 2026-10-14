/**
 * In-memory stand-ins for the JustTCG and Scryfall APIs, shaped like their real
 * responses (subtitled Cyberpunk names, "(M11)" set suffixes, per-language variants).
 */
import { vi } from "vitest";

type Variant = { condition: string; printing: string; language: string; price: number | null; lastUpdated: number };

const now = Math.floor(Date.now() / 1000);
const conditions = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

function variants(base: number, finishes = ["Normal", "Foil"]): Variant[] {
  const out: Variant[] = [];
  for (const printing of finishes) {
    conditions.forEach((condition, i) => {
      const price = +(base * (printing === "Foil" ? 3 : 1) * (1 - i * 0.15)).toFixed(2);
      out.push({ condition, printing, language: "English", price: condition === "Damaged" ? null : price, lastUpdated: now - 7200 });
    });
    // Foreign-language variants come back too and must be ignored.
    out.push({ condition: "Near Mint", printing: `${printing} - French`, language: "French", price: base * 9, lastUpdated: now });
  }
  return out;
}

export const JUSTTCG_CARDS = [
  { id: "mtg-m11-bolt", name: "Lightning Bolt", game: "Magic: The Gathering", set_name: "Magic 2011 (M11)", number: "149", rarity: "Common", tcgplayerId: "35427", scryfallId: "sf-m11-bolt", variants: variants(1.21) },
  { id: "mtg-2x2-bolt", name: "Lightning Bolt", game: "Magic: The Gathering", set_name: "Double Masters 2022 (2X2)", number: "117", rarity: "Uncommon", tcgplayerId: "1", scryfallId: "sf-2x2-bolt", variants: variants(2) },
  { id: "cp-jackie-mama", name: "Jackie Welles - Mama's Favorite", game: "Cyberpunk TCG", set_name: "Pre-Release Beta", number: "007", rarity: "R", tcgplayerId: "2", variants: variants(18.6, ["Foil"]) },
  { id: "cp-jackie-mama-rare", name: "Jackie Welles - Mama's Favorite (Rare)", game: "Cyberpunk TCG", set_name: "Welcome to Night City - Beta", number: "B073", rarity: "R", tcgplayerId: "3", variants: variants(0.36, ["Foil"]) },
  { id: "cp-jackie-ride", name: "Jackie Welles - Ride or Die Choom", game: "Cyberpunk TCG", set_name: "Welcome to Night City - Beta", number: "B048", rarity: "E", tcgplayerId: "4", variants: variants(8.74, ["Foil"]) },
  { id: "cp-jackie-pour", name: "Jackie Welles - Pour One Out For Me", game: "Cyberpunk TCG", set_name: "Box Toppers - Beta", number: "B005", rarity: "NR", tcgplayerId: "5", variants: variants(42.91, ["Foil"]) },
];

export const SCRYFALL_CARDS = [
  { id: "sf-m11-bolt", name: "Lightning Bolt", set: "m11", set_name: "Magic 2011", collector_number: "149", rarity: "common", released_at: "2010-07-16", prices: { usd: "1.21", usd_foil: "7.59" } },
  { id: "sf-2x2-bolt", name: "Lightning Bolt", set: "2x2", set_name: "Double Masters 2022", collector_number: "117", rarity: "uncommon", released_at: "2022-07-08", prices: { usd: "2.00", usd_foil: "6.00" } },
  { id: "sf-msc-bolt", name: "Lightning Bolt", set: "msc", set_name: "Marvel Super Heroes Commander", collector_number: "806", rarity: "common", released_at: "2026-06-01", prices: { usd: "0.90", usd_foil: null } },
].map((c) => ({ ...c, scryfall_uri: `https://scryfall.com/card/${c.set}/${c.collector_number}`, image_uris: { small: `https://img.test/${c.id}-s.jpg`, normal: `https://img.test/${c.id}.jpg` } }));

const GAMES = [
  { id: "magic-the-gathering", name: "Magic: The Gathering" },
  { id: "cyberpunk-tcg", name: "Cyberpunk TCG" },
  { id: "pokemon", name: "Pokemon" },
  { id: "pokemon-japan", name: "Pokemon Japan" },
];

const gameOf = (id: string) => GAMES.find((g) => g.id === id)?.name;

export type MockState = { calls: string[]; justtcg: "ok" | "429" };

export function installMockApis(): MockState {
  const state: MockState = { calls: [], justtcg: "ok" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.justtcg.com") {
      state.calls.push(`justtcg ${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if ((init?.headers as Record<string, string>)?.["x-api-key"] !== "test-key") return Response.json({}, { status: 401 });
      if (state.justtcg === "429") return Response.json({ error: "Too many requests" }, { status: 429 });
      const data = (cards: unknown[]) => Response.json({ data: cards, _metadata: { apiDailyRequestsRemaining: 99 } });
      if (url.pathname === "/v1/games") return data(GAMES);
      if (url.pathname === "/v1/cards" && init?.method === "POST") {
        // Batch pricing: known mock cards, plus a generated price for any other id (e.g. snapshot ids).
        const ids = (JSON.parse(String(init.body)) as { cardId: string }[]).map((i) => i.cardId);
        return data(ids.map((id) => JUSTTCG_CARDS.find((c) => c.id === id) ?? { id, name: id, variants: variants(5) }));
      }
      if (url.pathname === "/v1/cards") {
        const p = url.searchParams;
        if (p.get("scryfallId")) return data(JUSTTCG_CARDS.filter((c) => c.scryfallId === p.get("scryfallId")));
        if (p.get("cardId")) return data(JUSTTCG_CARDS.filter((c) => c.id === p.get("cardId")));
        const game = gameOf(p.get("game") ?? "");
        const words = (p.get("q") ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        return data(JUSTTCG_CARDS.filter((c) => c.game === game && words.some((w) => c.name.toLowerCase().includes(w))));
      }
    }
    if (url.host === "api.scryfall.com") {
      state.calls.push(`scryfall ${url.pathname}${url.search}`);
      const exact = url.pathname.match(/^\/cards\/([^/]+)\/([^/]+)$/);
      if (exact && exact[1] !== "named" && exact[1] !== "search") {
        const card = SCRYFALL_CARDS.find((c) => c.set === exact[1] && c.collector_number === exact[2]);
        return card ? Response.json(card) : Response.json({ object: "error" }, { status: 404 });
      }
      if (url.pathname === "/cards/named") {
        const q = (url.searchParams.get("fuzzy") ?? "").toLowerCase().replace(/[^a-z]/g, "");
        // Scryfall's default printing for a name is its newest.
        const card = [...SCRYFALL_CARDS].sort((a, b) => b.released_at.localeCompare(a.released_at)).find((c) => c.name.toLowerCase().replace(/[^a-z]/g, "").startsWith(q.slice(0, 8)));
        return card ? Response.json(card) : Response.json({ object: "error" }, { status: 404 });
      }
      if (url.pathname === "/cards/search") {
        const name = (url.searchParams.get("q") ?? "").match(/!"([^"]+)"/)?.[1];
        const cards = SCRYFALL_CARDS.filter((c) => c.name === name);
        return cards.length ? Response.json({ data: cards, has_more: false }) : Response.json({ object: "error" }, { status: 404 });
      }
    }
    throw new Error(`Unmocked request: ${url}`);
  });
  return state;
}

export { clearAllCaches as resetCaches } from "@/lib/cache";

export const ident = (game: string, title: string, extra: Partial<{ subtitle: string; setCode: string; collectorNumber: string; setNameGuess: string }> = {}) => ({
  isCard: true,
  game,
  title,
  subtitle: extra.subtitle ?? null,
  confidence: "high" as const,
  cardType: null,
  setCode: extra.setCode ?? null,
  collectorNumber: extra.collectorNumber ?? null,
  setNameGuess: extra.setNameGuess ?? null,
});
