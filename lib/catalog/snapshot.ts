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

export const SNAPSHOT_GAMES = Object.keys(SNAPSHOTS);

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

type PriceMap = Record<string, PriceVariant[]>;

// One map per game, refreshed at most once a day: ~3 batch requests price the whole game,
// so individual scans cost no JustTCG requests at all.
const priceMaps = namedCache<PriceMap>("snapshot-prices");

export async function refreshPriceMap(gameId: string): Promise<PriceMap> {
  const cards = await cardsByIds(SNAPSHOTS[gameId].cards.map((c) => c.id));
  const map: PriceMap = Object.fromEntries(cards.map((c) => [c.id, englishVariants(c.variants)]));
  await priceMaps.set(gameId, map);
  return map;
}

/**
 * Attach current prices to snapshot printings. Falls back to the snapshot's own prices
 * ("as of" its sync date) when there's no key or JustTCG is unavailable.
 */
export async function priceSnapshotPrintings(gameId: string, printings: CardPrinting[]): Promise<{ printings: CardPrinting[]; error: string | null }> {
  if (!hasJustTcgKey()) return { printings, error: null };
  let map = await priceMaps.get(gameId);
  let error: string | null = null;
  if (!map) {
    try {
      map = await refreshPriceMap(gameId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  if (!map) return { printings, error };
  return {
    printings: printings.map((p) => (map![p.id] ? { ...p, variants: map![p.id], priceAsOf: null } : p)),
    error: null,
  };
}
