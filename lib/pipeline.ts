import { retrieveCandidates } from "./catalog";
import { MAGIC } from "./catalog/games";
import { thumbnail } from "./catalog/scryfall";
import { chooseCandidate, type CallOptions } from "./claude";
import { priceMatch } from "./pricing";
import { PricingError } from "./pricing/justtcg";
import type { CardMatch, Identification } from "./types";

// Thumbnails cost ~40 tokens each, so Magic can show more; text-only games need fewer.
const chooserCandidates = (gameId: string) => (gameId === MAGIC ? 12 : 8);

export type MatchOptions = {
  /** Bypass caches for prices (Rescan). */
  fresh?: boolean;
  /** Skip pricing (the eval only measures identification). */
  price?: boolean;
  /** Model/effort for the second pass. */
  chooser?: CallOptions;
};

/**
 * The RAG step: retrieve real catalog candidates for what was read, let Claude pick
 * among them when several fit, then price the result.
 */
export async function matchCard(
  id: Identification,
  image: string,
  { fresh = false, price = true, chooser }: MatchOptions = {},
): Promise<{ match: CardMatch | null; error: string | null }> {
  if (!id.isCard || !id.title) return { match: null, error: null };

  let retrieval;
  try {
    retrieval = await retrieveCandidates(id);
  } catch (err) {
    if (!(err instanceof PricingError)) console.error("[match] retrieval failed:", err);
    return { match: null, error: err instanceof PricingError ? err.message : "Card lookup is temporarily unavailable." };
  }
  const { gameId, catalog, ranked } = retrieval;
  if (ranked.decision === "none") return { match: null, error: `No catalog match for “${id.title}”.` };

  let printings = ranked.candidates;
  let method: CardMatch["method"] = ranked.decision === "exact" ? "exact" : "ranked";

  if (ranked.decision === "ambiguous" && printings.length > 1) {
    const top = printings.slice(0, chooserCandidates(gameId));
    try {
      const thumbs = gameId === MAGIC ? await Promise.all(top.map(thumbnail)) : [];
      const chosenId = await chooseCandidate(image, top, thumbs, chooser);
      const chosen = printings.find((p) => p.id === chosenId);
      if (chosen) {
        printings = [chosen, ...printings.filter((p) => p !== chosen)];
        method = "chosen";
      }
    } catch (err) {
      // The ranked order still stands; the user can pick from the set dropdown.
      console.warn("[match] chooser failed:", err);
    }
  }

  if (!price) return { match: { method, printings, exactName: ranked.exactName, catalog }, error: null };
  const priced = await priceMatch(gameId, printings, { fresh });
  return {
    match: { method, printings: priced.printings, exactName: ranked.exactName, catalog },
    error: priced.error,
  };
}
