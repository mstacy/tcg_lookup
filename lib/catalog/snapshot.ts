import cyberpunk from "@/data/catalog/cyberpunk-tcg.json";
import { namedCache } from "../cache";
import { cardsByIds, englishVariants, hasJustTcgKey } from "../pricing/justtcg";
import type { CardPrinting, PriceVariant } from "../types";

/** Games small enough to keep their whole catalog in the repo (scripts/sync-catalog.ts). */
type Snapshot = {
  game: string;
  syncedAt: number;
  cards: {
    id: string;
    name: string;
    setName: string;
    number: string | null;
    rarity: string | null;
    tcgplayerId: string | null;
    variants: PriceVariant[];
  }[];
};

const SNAPSHOTS: Record<string, Snapshot> = { "cyberpunk-tcg": cyberpunk as Snapshot };

export function hasSnapshot(gameId: string): boolean {
  return gameId in SNAPSHOTS;
}

/** Every card in the game's snapshot, as printings priced from the snapshot itself. */
export function snapshotPrintings(gameId: string): CardPrinting[] {
  const snap = SNAPSHOTS[gameId];
  return snap.cards.map((c) => ({
    id: c.id,
    name: c.name,
    setName: c.setName,
    setCode: null,
    number: c.number,
    rarity: c.rarity && c.rarity !== "None" ? c.rarity : null,
    imageUrl: null,
    url: c.tcgplayerId ? `https://www.tcgplayer.com/product/${c.tcgplayerId}` : null,
    tcgplayerId: c.tcgplayerId,
    scryfallId: null,
    variants: c.variants,
    priceSource: "JustTCG",
    priceAsOf: snap.syncedAt,
    canRefinePrice: false,
  }));
}

// Per-card prices, cached for a day (shared across instances with Redis). A scan prices
// only its candidates, in one batch request, and only those not already priced today.
const cardPrices = namedCache<PriceVariant[]>("card-prices");

/**
 * Attach current prices to snapshot printings. Falls back to the snapshot's own prices
 * ("as of" its sync date) when there's no key or JustTCG is unavailable.
 */
export async function priceSnapshotPrintings(gameId: string, printings: CardPrinting[]): Promise<{ printings: CardPrinting[]; error: string | null }> {
  if (!hasJustTcgKey() || !printings.length) return { printings, error: null };

  const prices = new Map<string, PriceVariant[]>();
  const cached = await Promise.all(printings.map((p) => cardPrices.get(p.id)));
  printings.forEach((p, i) => cached[i] && prices.set(p.id, cached[i]!));

  const missing = printings.filter((p) => !prices.has(p.id)).map((p) => p.id);
  let error: string | null = null;
  if (missing.length) {
    try {
      const cards = await cardsByIds(missing);
      await Promise.all(
        cards.map((c) => {
          const variants = englishVariants(c.variants);
          prices.set(c.id, variants);
          return cardPrices.set(c.id, variants);
        }),
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    printings: printings.map((p) => (prices.has(p.id) ? { ...p, variants: prices.get(p.id)!, priceAsOf: null } : p)),
    // Snapshot prices still show, so only report an error when nothing could be priced.
    error: prices.size ? null : error,
  };
}
