/**
 * Ranking real catalog cards against what was read off a scan. Retrieval returns
 * candidates; this decides whether one is an exact match or the scan is ambiguous.
 */

export type Reading = {
  title: string;
  subtitle: string | null;
  setCode: string | null;
  number: string | null;
  /** Guessed set name (from the set symbol/frame); a weaker signal than a read set code. */
  setNameGuess?: string | null;
};

export type Rankable = { name: string; setName: string | null; setCode: string | null; number: string | null; rarity: string | null };

export type Ranked<T> = {
  candidates: T[];
  /** exact: one clear winner. ambiguous: several plausible. none: nothing matched the name. */
  decision: "exact" | "ambiguous" | "none";
  /** True when some candidate has exactly the read name (confirms the reading). */
  exactName: boolean;
};

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "045/271" -> "45"; letters kept ("B048" -> "b048"). */
export const normalizeNumber = (n: string | null | undefined) =>
  (n ?? "").trim().replace(/\/.*$/, "").replace(/^0+(?=\d)/, "").toLowerCase();
const digitsOnly = (n: string | null | undefined) => normalizeNumber(n).replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** Name for matching: drops "(Rare)"-style suffixes. */
const nameKey = (name: string) => normalizeTitle(name.replace(/\([^)]*\)/g, ""));
/** Character name without its subtitle: "Jackie Welles - Mama's Favorite" -> "jackie welles". */
const baseKey = (name: string) => nameKey(name.split(/\s+[-–—]\s+/)[0]);
/** Set name without a code suffix: "Magic 2011 (M11)" -> "magic 2011". */
const setKey = (name: string | null | undefined) => normalizeTitle((name ?? "").replace(/\([^)]*\)/g, ""));
const setCodeIn = (name: string | null | undefined) => (name ?? "").match(/\(([A-Za-z0-9]{2,6})\)\s*$/)?.[1]?.toLowerCase();

/** The full printed name: "Name - Subtitle" for games with epithets (Cyberpunk, Lorcana). */
export function fullName(title: string, subtitle: string | null) {
  return subtitle ? `${title} - ${subtitle}` : title;
}

/** Dice coefficient over character bigrams: 1 for identical names, ~0 for unrelated ones. */
export function similarity(a: string, b: string): number {
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

const TOP_K = 8;

/**
 * Rank catalog cards against a reading. Name filtering is strict (exact full name,
 * else same base name, else closest names); set code and collector number pick the
 * printing. Works over a whole catalog, not just a search page.
 */
export function rankCandidates<T extends Rankable>(cards: T[], reading: Reading, { limit = TOP_K } = {}): Ranked<T> {
  const full = nameKey(fullName(reading.title, reading.subtitle));
  const base = baseKey(reading.title);
  const faces = (c: T) => c.name.split("//");

  const exact = cards.filter((c) => faces(c).some((f) => nameKey(f) === full));
  const sameBase = exact.length ? [] : cards.filter((c) => faces(c).some((f) => baseKey(f) === base));
  let pool = exact.length ? exact : sameBase;
  if (!pool.length) {
    // Misread title: closest names, if any are reasonably close.
    pool = cards
      .map((c) => ({ c, s: similarity(nameKey(c.name), full) }))
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit * 2)
      .map((x) => x.c);
  }
  if (!pool.length) return { candidates: [], decision: "none", exactName: false };

  const number = normalizeNumber(reading.number);
  const setCode = reading.setCode?.toLowerCase();
  const numberScore = (c: T) =>
    number && normalizeNumber(c.number) === number ? 2 : number && digitsOnly(c.number) && digitsOnly(c.number) === digitsOnly(reading.number) ? 1 : 0;
  const setScore = (c: T) => (setCode && (c.setCode?.toLowerCase() === setCode || setCodeIn(c.setName) === setCode) ? 2 : 0);
  const guess = setKey(reading.setNameGuess);
  const guessScore = (c: T) => (guess && similarity(setKey(c.setName), guess) >= 0.8 ? 1.5 : 0);
  const score = (c: T) =>
    numberScore(c) +
    setScore(c) +
    guessScore(c) +
    (exact.length ? 0 : similarity(nameKey(c.name), full)) -
    // Without a set/number to go on, a regular printing is likelier than a promo.
    (/promo/i.test(`${c.setName} ${c.rarity}`) ? 0.25 : 0);

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const top = ranked[0];
  const runnerUp = ranked[1];
  // Exact: the only candidate with this name, or a number/set match that nothing else shares.
  const unique = ranked.length === 1 && exact.length === 1;
  const pinned = (numberScore(top) === 2 || (numberScore(top) >= 1 && setScore(top) === 2)) && (!runnerUp || score(runnerUp) < score(top) - 0.5);
  return {
    candidates: ranked.slice(0, limit),
    decision: exact.length && (unique || pinned) ? "exact" : "ambiguous",
    exactName: exact.length > 0 || (!reading.subtitle && sameBase.length > 0),
  };
}

export const _test = { nameKey, baseKey, setKey, setCodeIn, digitsOnly };
