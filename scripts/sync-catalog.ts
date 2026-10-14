/**
 * Snapshot a small game's full card catalog from JustTCG into data/catalog/<game>.json.
 * The app matches scans against this snapshot locally (no per-scan search requests).
 *
 *   npx tsx scripts/sync-catalog.ts [game-id]      (default: cyberpunk-tcg)
 *
 * Costs roughly one request per 20 cards (~22 for Cyberpunk TCG). Re-run when a new set releases.
 */
import fs from "node:fs";
import path from "node:path";

const GAME = process.argv[2] ?? "cyberpunk-tcg";
const ROOT = path.resolve(__dirname, "..");
const DELAY_MS = 6500; // free plan: 10 requests/minute

function apiKey(): string {
  if (process.env.JUSTTCG_API_KEY) return process.env.JUSTTCG_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const key = env.match(/^JUSTTCG_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error("Set JUSTTCG_API_KEY (env or .env.local).");
  return key;
}

const key = apiKey();
let requests = 0;

async function get<T>(pathname: string, params: Record<string, string | number>): Promise<T> {
  if (requests++) await new Promise((r) => setTimeout(r, DELAY_MS));
  const url = new URL(`https://api.justtcg.com/v1${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { "x-api-key": key } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${pathname}: ${JSON.stringify(body)}`);
  if (body._metadata) process.stdout.write(` [${body._metadata.apiDailyRequestsRemaining} left today]`);
  return body;
}

type ApiVariant = { condition: string; printing: string; language?: string; price: number | null; lastUpdated?: number };
type ApiCard = { id: string; name: string; set: string; set_name: string; number?: string; rarity?: string; tcgplayerId?: string; variants?: ApiVariant[] };

async function main() {
const sets = (await get<{ data: { id: string; name: string; cards_count: number }[] }>("/sets", { game: GAME })).data;
console.log(`\n${GAME}: ${sets.length} sets, ${sets.reduce((n, s) => n + (s.cards_count ?? 0), 0)} cards`);

const cards: unknown[] = [];
for (const set of sets) {
  for (let offset = 0; ; offset += 20) {
    process.stdout.write(`\n  ${set.name} @${offset}`);
    const page = await get<{ data: ApiCard[]; meta?: { hasMore?: boolean } }>("/cards", {
      game: GAME,
      set: set.id,
      limit: 20,
      offset,
      include_null_prices: "true",
      include_price_history: "false",
      include_statistics: "7d",
    });
    for (const c of page.data) {
      const english = (c.variants ?? []).filter((v) => !v.language || v.language === "English");
      cards.push({
        id: c.id,
        name: c.name,
        setId: c.set,
        setName: c.set_name,
        number: c.number && c.number !== "N/A" ? c.number : null,
        rarity: c.rarity ?? null,
        tcgplayerId: c.tcgplayerId ?? null,
        variants: english.map((v) => ({ condition: v.condition, printing: v.printing, price: v.price ?? null, lastUpdated: v.lastUpdated ?? null })),
      });
    }
    if (!page.meta?.hasMore || page.data.length < 20) break;
  }
}

const out = path.join(ROOT, "data/catalog", `${GAME}.json`);
fs.writeFileSync(out, JSON.stringify({ game: GAME, syncedAt: Math.floor(Date.now() / 1000), cards }, null, 0) + "\n");
console.log(`\n\nWrote ${cards.length} cards to ${path.relative(ROOT, out)} using ${requests} requests.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
