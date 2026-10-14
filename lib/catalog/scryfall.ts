import { namedCache } from "../cache";
import { hasJustTcgKey } from "../pricing/justtcg";
import type { CardPrinting } from "../types";
import { normalizeNumber, normalizeTitle } from "./match";

export type ScryfallCard = {
  id: string;
  name: string;
  scryfall_uri: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: { usd: string | null; usd_foil: string | null };
  image_uris?: { small?: string; normal?: string };
  card_faces?: { image_uris?: { small?: string; normal?: string } }[];
};

const HEADERS = { "User-Agent": "tcg-lookup/0.1", Accept: "application/json" };
const MAX_PRINTINGS = 350; // two pages; plenty for any real card

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.scryfall.com${path}`, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
  return (await res.json()) as T;
}

// Card data changes rarely; cache lookups for a day like everything else.
const exactCache = namedCache<ScryfallCard | null>("scryfall-exact");
const printsCache = namedCache<ScryfallCard[]>("scryfall-prints");

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The printing at set code + collector number, if it carries the name that was read. */
export async function exactPrinting(title: string, setCode: string | null, number: string | null): Promise<ScryfallCard | null> {
  const set = setCode?.trim().toLowerCase();
  const n = normalizeNumber(number);
  if (!set || !n || !/^[a-z0-9]{2,6}$/.test(set)) return null;
  const key = `${set}/${n}`;
  let card = exactCache.get(key);
  if (card === undefined) {
    card = await get<ScryfallCard>(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(n)}`);
    exactCache.set(key, card);
  }
  // A misread number could land on a different card; only trust it if the name agrees.
  return card && compact(card.name).startsWith(compact(title).slice(0, 10)) ? card : null;
}

/** Every printing of the card whose name best matches `title` (fuzzy, so misreads still resolve). */
export async function allPrintings(title: string): Promise<ScryfallCard[]> {
  const key = normalizeTitle(title);
  const cached = printsCache.get(key);
  if (cached) return cached;

  const named = await get<ScryfallCard>(`/cards/named?fuzzy=${encodeURIComponent(title)}`);
  if (!named) {
    printsCache.set(key, []);
    return [];
  }
  const cards: ScryfallCard[] = [];
  let next: string | null = `/cards/search?q=${encodeURIComponent(`!"${named.name}"`)}&unique=prints&order=released`;
  while (next && cards.length < MAX_PRINTINGS) {
    const page: { data: ScryfallCard[]; has_more: boolean; next_page?: string } | null = await get(next);
    if (!page) break;
    cards.push(...page.data);
    next = page.has_more && page.next_page ? page.next_page.replace("https://api.scryfall.com", "") : null;
  }
  const result = cards.length ? cards : [named];
  printsCache.set(key, result);
  return result;
}

const toPrice = (v: string | null) => (v ? Number(v) : null);
const image = (c: ScryfallCard, size: "small" | "normal") => c.image_uris?.[size] ?? c.card_faces?.[0]?.image_uris?.[size] ?? null;

/** A Scryfall printing with its TCGplayer Near Mint prices (JustTCG adds conditions on demand). */
export function toPrinting(card: ScryfallCard): CardPrinting {
  const variants = [
    { printing: "Normal", price: toPrice(card.prices.usd) },
    { printing: "Foil", price: toPrice(card.prices.usd_foil) },
  ]
    .filter((v) => v.price !== null)
    .map((v) => ({ ...v, condition: "Near Mint", lastUpdated: null }));
  return {
    id: card.id,
    name: card.name,
    setName: card.set_name,
    setCode: card.set.toUpperCase(),
    number: card.collector_number,
    rarity: card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1),
    imageUrl: image(card, "normal"),
    url: card.scryfall_uri,
    tcgplayerId: null,
    scryfallId: card.id,
    variants,
    priceSource: variants.length ? "Scryfall (TCGplayer market)" : null,
    priceAsOf: null,
    canRefinePrice: hasJustTcgKey(),
  };
}

/** Small card image as base64, for showing candidates to Claude (~40 tokens each). */
export async function thumbnail(printing: CardPrinting): Promise<string | null> {
  const url = printing.imageUrl?.replace("/normal/", "/small/");
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"], Accept: "image/*" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("image/jpeg")) return null;
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  } catch {
    return null;
  }
}
