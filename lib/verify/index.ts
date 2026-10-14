import { namedCache } from "../cache";
import type { Verification } from "../types";
import { verifyMagic } from "./scryfall";

export type PrintingHints = { setCode?: string | null; collectorNumber?: string | null };

type Verifier = {
  /** Stable id, used in cache keys so "MTG" and "Magic: The Gathering" share entries. */
  id: string;
  /** Matches the game name returned by the model. */
  matches: (game: string) => boolean;
  verify: (title: string, hints: PrintingHints) => Promise<Verification | null>;
};

// Add Pokémon (pokemontcg.io), Yu-Gi-Oh! (YGOPRODeck), etc. here.
// Cyberpunk TCG has no public card database API; JustTCG pricing still covers it.
const VERIFIERS: Verifier[] = [
  { id: "mtg", matches: (game) => /magic|mtg/i.test(game), verify: verifyMagic },
];

// Keyed by title + printing hints. Caches misses too (as null) so an unknown card
// isn't re-searched within 24h.
const titleCache = namedCache<Verification | null>("verify-by-title");

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function verifyCard(
  game: string | null,
  title: string | null,
  { fresh = false, hints = {} as PrintingHints } = {},
): Promise<Verification | null> {
  if (!game || !title) return null;
  const verifier = VERIFIERS.find((v) => v.matches(game));
  if (!verifier) return null;

  const key = [verifier.id, normalizeTitle(title), normalizeTitle(hints.setCode ?? ""), normalizeTitle(hints.collectorNumber ?? "")].join("|");
  const cached = fresh ? undefined : titleCache.get(key);
  if (cached !== undefined) {
    console.log(`[verify] cache hit: ${key}`);
    return cached;
  }

  try {
    const result = await verifier.verify(title, hints);
    titleCache.set(key, result);
    return result;
  } catch (err) {
    // Lookup failures (timeouts, 5xx) are not cached, so the next scan retries.
    console.warn("[verify] lookup failed:", err);
    return null;
  }
}
