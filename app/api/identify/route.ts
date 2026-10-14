import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { retrieveCandidates } from "@/lib/catalog";
import { MAGIC } from "@/lib/catalog/games";
import { thumbnail } from "@/lib/catalog/scryfall";
import { chooseCandidate, identifyCard, IdentifyError } from "@/lib/claude";
import { priceMatch } from "@/lib/pricing";
import { PricingError } from "@/lib/pricing/justtcg";
import { allowRequest } from "@/lib/rateLimit";
import type { CardMatch, Identification, IdentifyResponse } from "@/lib/types";

export const runtime = "nodejs";

const MAX_IMAGE_BASE64_CHARS = 5_500_000; // ~4 MB decoded
// Thumbnails cost ~40 tokens each, so Magic can show more; text-only games need fewer.
const chooserCandidates = (gameId: string) => (gameId === MAGIC ? 12 : 8);

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Retrieve real catalog candidates for what was read, let Claude pick among them when
 * several fit (the RAG step), then price the result.
 */
async function matchCard(id: Identification, image: string, fresh: boolean): Promise<{ match: CardMatch | null; error: string | null }> {
  if (!id.isCard || !id.title) return { match: null, error: null };

  let retrieval;
  try {
    retrieval = await retrieveCandidates(id);
  } catch (err) {
    if (!(err instanceof PricingError)) console.error("[identify] retrieval failed:", err);
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
      const chosenId = await chooseCandidate(image, top, thumbs);
      const chosen = printings.find((p) => p.id === chosenId);
      if (chosen) {
        printings = [chosen, ...printings.filter((p) => p !== chosen)];
        method = "chosen";
      }
    } catch (err) {
      // The ranked order still stands; the user can pick from the set dropdown.
      console.warn("[identify] chooser failed:", err);
    }
  }

  const priced = await priceMatch(gameId, printings, { fresh });
  return {
    match: { method, printings: priced.printings, exactName: ranked.exactName, catalog },
    error: priced.error,
  };
}

export async function POST(req: NextRequest) {
  let body: { image?: unknown };
  try {
    body = await req.json();
  } catch {
    return error("Body must be JSON.", 400);
  }

  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/jpeg;base64,/, "") : null;
  if (!image || !/^[A-Za-z0-9+/]+=*$/.test(image)) return error("`image` must be a base64 JPEG.", 400);
  if (image.length > MAX_IMAGE_BASE64_CHARS) return error("Image too large (max ~4 MB).", 413);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (!(await allowRequest(ip))) return error("Too many scans. Wait a minute and try again.", 429);

  let identification: Identification;
  try {
    identification = await identifyCard(image);
  } catch (err) {
    if (err instanceof IdentifyError) return error(err.message, err.status);
    if (err instanceof Anthropic.AuthenticationError) return error("Server is missing a valid ANTHROPIC_API_KEY.", 500);
    if (err instanceof Anthropic.RateLimitError) return error("Model rate limit hit. Try again shortly.", 429);
    if (err instanceof Anthropic.APIError) return error(`Model error: ${err.message}`, 502);
    console.error("[identify] unexpected error:", err);
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return error("Server has no Anthropic credentials. Set ANTHROPIC_API_KEY in .env.local.", 500);
    }
    return error("Unexpected server error.", 500);
  }

  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const { match, error: pricingError } = await matchCard(identification, image, fresh);

  const response: IdentifyResponse = { identification, match, pricingError, cache: "none", scannedAt: Date.now() };
  return NextResponse.json(response);
}
