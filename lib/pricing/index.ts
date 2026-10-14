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
const digitsOnly = (n: string | null | undefined) => normalizeNumber(n).replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** Name for matching: drops "(Rare)"-style suffixes. */
const nameKey = (name: string) => normalizeTitle(name.replace(/\([^)]*\)/g, ""));
/** Character name without its subtitle: "Jackie Welles - Mama's Favorite" -> "jackie welles". */
const baseKey = (name: string) => nameKey(name.split(/\s+[-–—]\s+/)[0]);
/** Set name without the code suffix: "Magic 2011 (M11)" -> "magic 2011". */
const setKey = (name: string | null | undefined) => normalizeTitle((name ?? "").replace(/\([^)]*\)/g, ""));
const setCodeIn = (name: string | null | undefined) => (name ?? "").match(/\(([A-Za-z0-9]{2,6})\)\s*$/)?.[1]?.toLowerCase();

/** Dice coefficient over character bigrams: 1 for identical names, ~0 for unrelated ones. */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
    return out;
  };
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const [k, n] of x) shared += Math.min(n, y.get(k) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * shared) / total : 0;
}

type Hints = { subtitle: string | null; number: string | null; setName: string | null; setCode: string | null };

/** The name to search for: "Name - Subtitle" when the card has a subtitle (Cyberpunk, Lorcana). */
export function searchName(title: string, subtitle: string | null) {
  return subtitle ? `${title} - ${subtitle}` : title;
}

/** Order candidate printings by how well they match what was read off the card. */
function rankPrintings(printings: CardPrinting[], title: string, hints: Hints) {
  // Search is fuzzy. Prefer exact full-name matches (either face of "Front // Back"),
  // then cards sharing the base name (same character, other subtitle), then anything.
  const full = nameKey(searchName(title, hints.subtitle));
  const exact = printings.filter((p) => p.name.split("//").some((face) => nameKey(face) === full));
  const base = printings.filter((p) => baseKey(p.name) === baseKey(title));
  const pool = exact.length ? exact : base.length ? base : printings;
  // Without a legible subtitle, a base-name match still confirms the title reading.
  const exactName = exact.length > 0 || (!hints.subtitle && base.length > 0);

  const number = normalizeNumber(hints.number);
  const setName = setKey(hints.setName);
  const setCode = hints.setCode?.toLowerCase();
  const score = (p: CardPrinting) =>
    (number && normalizeNumber(p.number) === number ? 2 : number && digitsOnly(p.number) === digitsOnly(hints.number) ? 1 : 0) +
    ((setName && setKey(p.setName) === setName) || (setCode && setCodeIn(p.setName) === setCode) ? 2 : 0) +
    // Closest name first when the subtitle didn't match exactly (e.g. misread).
    (exact.length ? 0 : similarity(nameKey(p.name), full)) +
    (p.variants.some((v) => v.price !== null) ? 1 : 0) -
    // Tie-break: without a set/number to go on, a regular printing is likelier than a promo.
    (/promo/i.test(`${p.setName} ${p.rarity}`) ? 0.5 : 0);

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const confident = ranked.length === 1 || (ranked.length > 0 && score(ranked[0]) >= 2);
  return { printings: ranked, confident, exactName };
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
  const subtitle = verification ? null : id.subtitle;
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
    let found = await searchCards(gameId, searchName(title, subtitle));
    // A misread subtitle can sink the search; retry once with the base name.
    if (!found.length && subtitle) found = await searchCards(gameId, title);
    if (!found.length) throw new PricingError("No price listing found for this card.");

    // Scryfall's set/number are only evidence when they came from the card itself;
    // a name-only match returns an arbitrary default printing.
    const exact = verification?.exactPrinting;
    const { printings, confident, exactName } = rankPrintings(found, title, {
      subtitle,
      number: exact ? verification!.number : id.collectorNumber,
      setName: exact ? verification!.setName : null,
      setCode: exact ? verification!.setCode : id.setCode,
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
    normalizeTitle(id.subtitle ?? ""),
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
