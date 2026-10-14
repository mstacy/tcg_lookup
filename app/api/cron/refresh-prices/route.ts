import { NextRequest, NextResponse } from "next/server";
import { refreshPriceMap, SNAPSHOT_GAMES } from "@/lib/catalog/snapshot";

export const runtime = "nodejs";

/**
 * Daily price refresh for snapshot games (vercel.json cron). Re-prices each whole game
 * with a few batch requests and stores the map in the shared cache, so scans themselves
 * cost no JustTCG requests. Vercel sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, number | string> = {};
  for (const gameId of SNAPSHOT_GAMES) {
    try {
      results[gameId] = Object.keys(await refreshPriceMap(gameId)).length;
    } catch (err) {
      results[gameId] = err instanceof Error ? err.message : String(err);
    }
  }
  console.log("[cron] refreshed prices:", results);
  return NextResponse.json({ refreshed: results });
}
