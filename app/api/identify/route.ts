import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { identifyCard, IdentifyError } from "@/lib/claude";
import { matchCard } from "@/lib/pipeline";
import { allowRequest } from "@/lib/rateLimit";
import type { Identification, IdentifyResponse } from "@/lib/types";

export const runtime = "nodejs";

const MAX_IMAGE_BASE64_CHARS = 5_500_000; // ~4 MB decoded

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
  const { match, error: pricingError } = await matchCard(identification, image, { fresh });

  const response: IdentifyResponse = { identification, match, pricingError, cache: "none", scannedAt: Date.now() };
  return NextResponse.json(response);
}
