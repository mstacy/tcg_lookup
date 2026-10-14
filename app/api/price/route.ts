import { NextRequest, NextResponse } from "next/server";
import { refinePrice } from "@/lib/pricing";
import { PricingError } from "@/lib/pricing/justtcg";
import { allowRequest } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Per-condition prices for one printing, fetched when someone picks a different
 * printing from the set dropdown: GET /api/price?scryfallId=… or ?cardId=…
 */
export async function GET(req: NextRequest) {
  const scryfallId = req.nextUrl.searchParams.get("scryfallId");
  const cardId = req.nextUrl.searchParams.get("cardId");
  const id = scryfallId ? { scryfallId } : cardId ? { cardId } : null;
  if (!id || !/^[\w-]{1,200}$/.test(scryfallId ?? cardId ?? "")) {
    return NextResponse.json({ error: "Pass scryfallId or cardId." }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (!(await allowRequest(ip))) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  try {
    const refined = await refinePrice(id);
    if (!refined) return NextResponse.json({ error: "No price listing for this printing." }, { status: 404 });
    return NextResponse.json(refined);
  } catch (err) {
    if (err instanceof PricingError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error("[price] unexpected error:", err);
    return NextResponse.json({ error: "Pricing is temporarily unavailable." }, { status: 500 });
  }
}
