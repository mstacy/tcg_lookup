import type { CardPrinting, PriceVariant } from "../types";

const BASE_URL = "https://api.justtcg.com/v1";
const BATCH_SIZE = 200;

/** A pricing failure with a message that is safe to show to the user. */
export class PricingError extends Error {}

export type ApiVariant = {
  condition: string;
  printing: string;
  language?: string;
  price: number | null;
  lastUpdated?: number;
};

export type ApiCard = {
  id: string;
  name: string;
  set_name?: string;
  number?: string;
  rarity?: string;
  tcgplayerId?: string;
  scryfallId?: string;
  variants?: ApiVariant[];
};

export function hasJustTcgKey(): boolean {
  return Boolean(process.env.JUSTTCG_API_KEY);
}

async function call<T>(path: string, params: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
  const key = process.env.JUSTTCG_API_KEY;
  if (!key) throw new PricingError("Add JUSTTCG_API_KEY to enable pricing.");

  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return (await res.json()) as T;
  // A GET lookup for an identifier JustTCG doesn't list is "no data", not a failure.
  const isGet = !body;
  if (res.status === 404 && isGet) return { data: [] } as T;

  const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  console.warn(`[justtcg] ${res.status} ${path}`, err);
  if (err.code === "EXCESSIVE_FREE_TIER_USAGE") {
    throw new PricingError("JustTCG blocked this free API key on a shared host. A paid key fixes this.");
  }
  if (res.status === 429) throw new PricingError("JustTCG rate limit reached. Prices will be back shortly.");
  if (res.status === 401 || res.status === 403) throw new PricingError("JustTCG rejected the API key.");
  throw new PricingError(`JustTCG returned an error (${res.status}).`);
}

/** English prices when a card has variants in several languages. */
export function englishVariants(variants: ApiVariant[] = []): PriceVariant[] {
  const english = variants.filter((v) => !v.language || v.language === "English");
  return (english.length ? english : variants).map((v) => ({
    condition: v.condition,
    printing: v.printing,
    price: v.price ?? null,
    lastUpdated: v.lastUpdated ?? null,
  }));
}

export function toPrinting(card: ApiCard): CardPrinting {
  return {
    id: card.id,
    name: card.name,
    setName: card.set_name ?? null,
    setCode: null,
    number: card.number && card.number !== "N/A" ? card.number : null,
    rarity: card.rarity ?? null,
    imageUrl: null,
    url: card.tcgplayerId ? `https://www.tcgplayer.com/product/${card.tcgplayerId}` : null,
    tcgplayerId: card.tcgplayerId ?? null,
    scryfallId: card.scryfallId ?? null,
    variants: englishVariants(card.variants),
    priceSource: "JustTCG",
    priceAsOf: null,
    canRefinePrice: false,
  };
}

const LIGHT_RESPONSE = { include_price_history: "false", include_statistics: "7d" };

/** Name search within a game (up to 20 results on the free plan). */
export async function searchCards(gameId: string, name: string): Promise<CardPrinting[]> {
  const res = await call<{ data: ApiCard[] }>("/cards", { q: name, game: gameId, limit: 20, ...LIGHT_RESPONSE });
  return res.data.map(toPrinting);
}

/** One card by Scryfall id (Magic) or JustTCG card id. */
export async function cardBy(id: { scryfallId: string } | { cardId: string }): Promise<ApiCard | null> {
  const res = await call<{ data: ApiCard[] }>("/cards", { ...id, ...LIGHT_RESPONSE });
  return res.data[0] ?? null;
}

/** Many cards by JustTCG card id, 200 per request (a whole small game in a few requests). */
export async function cardsByIds(cardIds: string[]): Promise<ApiCard[]> {
  const out: ApiCard[] = [];
  for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
    const batch = cardIds.slice(i, i + BATCH_SIZE).map((cardId) => ({ cardId }));
    const res = await call<{ data: ApiCard[] }>("/cards", LIGHT_RESPONSE, batch);
    out.push(...res.data);
  }
  return out;
}
