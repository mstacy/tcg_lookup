import { namedCache } from "../cache";
import type { CardPrinting, Identification, Pricing, Verification } from "../types";
import { normalizeTitle } from "../verify";
import { cardByScryfallId, hasJustTcgKey, PricingError, resolveGameId, searchCards } from "./justtcg";

type PricingResult = { pricing: Pricing | null; error: string | null };

// 24h cache per card + printing hints. JustTCG's free plan allows 100 requests/day,
// so the same card must never be priced twice within a day.
const priceCache = namedCache<PricingResult>("pricing");

const normalizeNumber = (n: string | null | undefined) =>
  (n ?? "").trim().replace(/\/.*$/, "").replace(/^0+(?=\d)/, "").toLowerCase();

/** Order candidate printings by how well they match what was read off the card. */
function rankPrintings(
  printings: CardPrinting[],
  title: string,
  hints: { number: string | null; setName: string | null },
): { printings: CardPrinting[]; confident: boolean; exactName: boolean } {
  const wanted = normalizeTitle(title.split("//")[0]);
  // Search is fuzzy; keep exact name matches when there are any. Double-faced cards
  // ("Front // Back") match on either face, but "Name, Subtitle" is a different card.
  const named = printings.filter((p) => p.name.split("//").some((face) => normalizeTitle(face) === wanted));
  const pool = named.length ? named : printings;

  const number = normalizeNumber(hints.number);
  const setName = normalizeTitle(hints.setName ?? "");
  const score = (p: CardPrinting) =>
    (number && normalizeNumber(p.number) === number ? 2 : 0) +
    (setName && normalizeTitle(p.setName ?? "") === setName ? 2 : 0) +
    (p.variants.some((v) => v.price !== null) ? 1 : 0) -
    // Tie-break: without a set/number to go on, a regular printing is likelier than a promo.
    (/promo/i.test(`${p.setName} ${p.rarity}`) ? 0.5 : 0);

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const confident = ranked.length === 1 || (ranked.length > 0 && score(ranked[0]) >= 2);
  return { printings: ranked, confident, exactName: named.length > 0 };
}

/** Fallback for Magic: Scryfall's TCGplayer market price (Near Mint only, no conditions). */
function scryfallPricing(v: Verification): Pricing | null {
  if (!v.prices || (v.prices.usd === null && v.prices.usdFoil === null)) return null;
  const variants = [
    { printing: "Normal", price: v.prices.usd },
    { printing: "Foil", price: v.prices.usdFoil },
  ]
    .filter((x) => x.price !== null)
    .map((x) => ({ ...x, condition: "Near Mint", lastUpdated: null }));
  return {
    source: "Scryfall (TCGplayer market)",
    printings: [
      { id: v.scryfallId ?? v.name, name: v.name, setName: v.setName, number: v.number, rarity: v.rarity, tcgplayerId: null, variants },
    ],
    confident: v.exactPrinting,
    exactName: true,
  };
}

async function fetchPricing(id: Identification, verification: Verification | null): Promise<PricingResult> {
  const title = verification?.name ?? id.title!;
  try {
    // Magic with an exact printing: price exactly that printing by Scryfall id.
    if (verification?.exactPrinting && verification.scryfallId) {
      const printing = await cardByScryfallId(verification.scryfallId);
      if (printing) {
        return { pricing: { source: "JustTCG", printings: [printing], confident: true, exactName: true }, error: null };
      }
    }
    const gameId = await resolveGameId(id.game!);
    if (!gameId) throw new PricingError(`JustTCG doesn't cover ${id.game}.`);
    const found = await searchCards(gameId, title);
    if (!found.length) throw new PricingError("No price listing found for this card.");

    const { printings, confident, exactName } = rankPrintings(found, title, {
      number: verification?.number ?? id.collectorNumber,
      setName: verification?.setName ?? null,
    });
    return { pricing: { source: "JustTCG", printings, confident, exactName }, error: null };
  } catch (err) {
    if (!(err instanceof PricingError)) console.error("[pricing] unexpected error:", err);
    const message = err instanceof PricingError ? err.message : "Pricing is temporarily unavailable.";
    const fallback = verification ? scryfallPricing(verification) : null;
    return { pricing: fallback, error: fallback ? null : message };
  }
}

export async function getPricing(
  id: Identification,
  verification: Verification | null,
  { fresh = false } = {},
): Promise<PricingResult> {
  if (!id.isCard || !id.game || !(verification?.name ?? id.title)) return { pricing: null, error: null };
  if (!hasJustTcgKey()) {
    const fallback = verification ? scryfallPricing(verification) : null;
    return { pricing: fallback, error: fallback ? null : "Add JUSTTCG_API_KEY to enable pricing." };
  }

  const key = [
    normalizeTitle(id.game),
    normalizeTitle(verification?.name ?? id.title ?? ""),
    verification?.scryfallId ?? "",
    normalizeTitle(id.setCode ?? ""),
    normalizeNumber(id.collectorNumber),
  ].join("|");
  const cached = fresh ? undefined : priceCache.get(key);
  if (cached) {
    console.log(`[pricing] cache hit: ${key}`);
    return cached;
  }

  const result = await fetchPricing(id, verification);
  // Cache real answers (incl. "no listing"), not transient failures like rate limits.
  if (result.pricing?.source === "JustTCG" || result.error === "No price listing found for this card.") {
    priceCache.set(key, result);
  }
  return result;
}
