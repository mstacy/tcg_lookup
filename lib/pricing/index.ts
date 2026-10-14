import { namedCache } from "../cache";
import { MAGIC } from "../catalog/games";
import { hasSnapshot, priceSnapshotPrintings } from "../catalog/snapshot";
import type { CardPrinting, PriceVariant } from "../types";
import { cardBy, englishVariants, hasJustTcgKey, PricingError } from "./justtcg";

type Refined = { variants: PriceVariant[]; tcgplayerId: string | null };

// Per-printing JustTCG prices, cached for a day so a card is never priced twice.
const printingPrices = namedCache<Refined | null>("printing-prices");

/** Full per-condition JustTCG prices for one printing (by Scryfall id or JustTCG card id). */
export async function refinePrice(id: { scryfallId: string } | { cardId: string }, { fresh = false } = {}): Promise<Refined | null> {
  const key = "scryfallId" in id ? `sf:${id.scryfallId}` : `jt:${id.cardId}`;
  const cached = fresh ? undefined : await printingPrices.get(key);
  if (cached !== undefined) return cached;
  const card = await cardBy(id);
  const result = card ? { variants: englishVariants(card.variants), tcgplayerId: card.tcgplayerId ?? null } : null;
  await printingPrices.set(key, result);
  return result;
}

export function applyRefined(p: CardPrinting, r: Refined): CardPrinting {
  return {
    ...p,
    variants: r.variants,
    tcgplayerId: r.tcgplayerId ?? p.tcgplayerId,
    priceSource: "JustTCG",
    priceAsOf: null,
    canRefinePrice: false,
  };
}

/**
 * Put the best available prices on matched printings. Magic: per-condition JustTCG
 * prices for the top printing (others refine on demand); snapshot games: the shared
 * daily price map; searched games already carry prices.
 */
export async function priceMatch(
  gameId: string,
  printings: CardPrinting[],
  { fresh = false } = {},
): Promise<{ printings: CardPrinting[]; error: string | null }> {
  if (!printings.length) return { printings, error: null };

  if (hasSnapshot(gameId)) return priceSnapshotPrintings(gameId, printings);

  if (gameId === MAGIC && hasJustTcgKey() && printings[0].scryfallId) {
    try {
      const refined = await refinePrice({ scryfallId: printings[0].scryfallId }, { fresh });
      if (refined) return { printings: [applyRefined(printings[0], refined), ...printings.slice(1)], error: null };
    } catch (err) {
      // Keep Scryfall's Near Mint price; only report the error if nothing is priced.
      if (!(err instanceof PricingError)) console.error("[pricing] unexpected error:", err);
      const message = err instanceof PricingError ? err.message : "Pricing is temporarily unavailable.";
      return { printings, error: printings[0].variants.length ? null : message };
    }
  }

  const priced = printings[0].variants.length > 0;
  return { printings, error: priced || hasJustTcgKey() ? null : "Add JUSTTCG_API_KEY to enable pricing." };
}
