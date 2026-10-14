import { namedCache } from "../cache";
import type { CardPrinting } from "../types";

const BASE_URL = "https://api.justtcg.com/v1";

/** A pricing failure with a message that is safe to show to the user. */
export class PricingError extends Error {}

type ApiVariant = {
  condition: string;
  printing: string;
  language?: string;
  price: number | null;
  lastUpdated?: number;
};

type ApiCard = {
  id: string;
  name: string;
  set_name?: string;
  number?: string;
  rarity?: string;
  tcgplayerId?: string;
  variants?: ApiVariant[];
};

type ApiGame = { id: string; name: string };

export function hasJustTcgKey(): boolean {
  return Boolean(process.env.JUSTTCG_API_KEY);
}

async function call<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) throw new PricingError("Add JUSTTCG_API_KEY to enable pricing.");

  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(8000) });
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  console.warn(`[justtcg] ${res.status} ${path}`, body);
  if (body.code === "EXCESSIVE_FREE_TIER_USAGE") {
    throw new PricingError("JustTCG blocked this free API key on a shared host. A paid key fixes this.");
  }
  if (res.status === 429) throw new PricingError("JustTCG rate limit reached. Prices will be back shortly.");
  if (res.status === 401 || res.status === 403) throw new PricingError("JustTCG rejected the API key.");
  throw new PricingError(`JustTCG returned an error (${res.status}).`);
}

const gamesCache = namedCache<ApiGame[]>("justtcg-games");

const normalize = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const GAME_ALIASES: Record<string, string> = {
  mtg: "magic the gathering",
  magic: "magic the gathering",
  "pokemon tcg": "pokemon",
  "yu gi oh": "yugioh",
  lorcana: "disney lorcana",
  "cyberpunk 2077 tcg": "cyberpunk tcg",
  "cyberpunk 2077 trading card game": "cyberpunk tcg",
  "cyberpunk trading card game": "cyberpunk tcg",
};

/** Map the model's game name (e.g. "MTG", "Cyberpunk TCG") to a JustTCG game id. */
export async function resolveGameId(game: string): Promise<string | null> {
  let games = gamesCache.get("all");
  if (!games) {
    games = (await call<{ data: ApiGame[] }>("/games", {})).data;
    gamesCache.set("all", games);
  }
  const wanted = GAME_ALIASES[normalize(game)] ?? normalize(game);
  const exact = games.find((g) => normalize(g.name) === wanted || g.id === wanted.replace(/ /g, "-"));
  if (exact) return exact.id;
  // Loose match, shortest name first so "Pokemon" beats "Pokemon Japan".
  const loose = games
    .filter((g) => normalize(g.name).includes(wanted) || wanted.includes(normalize(g.name)))
    .sort((a, b) => a.name.length - b.name.length);
  return loose[0]?.id ?? null;
}

function toPrinting(card: ApiCard): CardPrinting {
  const variants = card.variants ?? [];
  // Prefer English prices when the card has variants in several languages.
  const english = variants.filter((v) => !v.language || v.language === "English");
  return {
    id: card.id,
    name: card.name,
    setName: card.set_name ?? null,
    number: card.number && card.number !== "N/A" ? card.number : null,
    rarity: card.rarity ?? null,
    tcgplayerId: card.tcgplayerId ?? null,
    variants: (english.length ? english : variants).map((v) => ({
      condition: v.condition,
      printing: v.printing,
      price: v.price ?? null,
      lastUpdated: v.lastUpdated ?? null,
    })),
  };
}

const LIGHT_RESPONSE = { include_price_history: "false", include_statistics: "7d" };

/** Every printing JustTCG knows for this name in this game (up to 20 on the free plan). */
export async function searchCards(gameId: string, name: string): Promise<CardPrinting[]> {
  const res = await call<{ data: ApiCard[] }>("/cards", { q: name, game: gameId, limit: 20, ...LIGHT_RESPONSE });
  return res.data.map(toPrinting);
}

/** The exact printing for a Scryfall id (Magic only). */
export async function cardByScryfallId(scryfallId: string): Promise<CardPrinting | null> {
  const res = await call<{ data: ApiCard[] }>("/cards", { scryfallId, ...LIGHT_RESPONSE });
  return res.data[0] ? toPrinting(res.data[0]) : null;
}
