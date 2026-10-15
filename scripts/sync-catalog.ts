/**
 * Snapshot a small game's full card catalog from JustTCG into data/catalog/<game>.json.
 * The app matches scans against this snapshot locally (no per-scan search requests).
 *
 *   npx tsx scripts/sync-catalog.ts [game-id] [--check | --force] [--summary <file>]
 *
 *   (default game: cyberpunk-tcg)
 *   --check          Compare JustTCG's set list (1 request) with the one recorded at the last
 *                    sync, and only re-sync when a set was added, removed or changed size.
 *   --force          Always re-sync (the default without --check).
 *   --summary <file> Write a Markdown summary of added/removed cards (used for the PR body).
 *
 * A full sync costs roughly one request per 20 cards (~32 for Cyberpunk TCG).
 * .github/workflows/sync-catalog.yml runs this weekly with --check.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const GAME = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--summary") ?? "cyberpunk-tcg";
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data/catalog", `${GAME}.json`);
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

type ApiSet = { id: string; name: string; cards_count: number };
type ApiVariant = { condition: string; printing: string; language?: string; price: number | null; lastUpdated?: number };
type ApiCard = { id: string; name: string; set: string; set_name: string; number?: string; rarity?: string; tcgplayerId?: string; variants?: ApiVariant[] };
type SnapshotSet = { id: string; name: string; cardsCount: number };
type SnapshotCard = { id: string; name: string; setName: string; number: string | null };
type Snapshot = { game: string; syncedAt: number; sets?: SnapshotSet[]; cards: SnapshotCard[] };

const setKey = (s: SnapshotSet) => `${s.id}:${s.cardsCount}`;

function readSnapshot(): Snapshot | null {
  return fs.existsSync(OUT) ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as Snapshot) : null;
}

/** Markdown list of cards added and removed between two snapshots. */
function describeChanges(before: Snapshot | null, after: Snapshot): string {
  const label = (c: SnapshotCard) => `${c.name} (${c.setName}${c.number ? ` #${c.number}` : ""})`;
  const oldIds = new Set(before?.cards.map((c) => c.id));
  const newIds = new Set(after.cards.map((c) => c.id));
  const added = after.cards.filter((c) => !oldIds.has(c.id));
  const removed = (before?.cards ?? []).filter((c) => !newIds.has(c.id));
  const list = (cards: SnapshotCard[]) =>
    cards.slice(0, 100).map((c) => `- ${label(c)}`).join("\n") + (cards.length > 100 ? `\n- …and ${cards.length - 100} more` : "");
  return [
    `Automated weekly sync of the ${GAME} catalog snapshot (\`scripts/sync-catalog.ts\`).`,
    "",
    `**${after.cards.length} cards** (was ${before?.cards.length ?? 0}): ${added.length} added, ${removed.length} removed.`,
    added.length ? `\n### Added\n${list(added)}` : "",
    removed.length ? `\n### Removed\n${list(removed)}` : "",
    "\nMerging deploys the updated catalog, so scans can match the new cards.",
  ].join("\n");
}

async function main() {
  const before = readSnapshot();
  const sets: SnapshotSet[] = (await get<{ data: ApiSet[] }>("/sets", { game: GAME })).data.map((s) => ({
    id: s.id,
    name: s.name,
    cardsCount: s.cards_count ?? 0,
  }));
  console.log(`\n${GAME}: ${sets.length} sets, ${sets.reduce((n, s) => n + s.cardsCount, 0)} cards listed`);

  if (flag("check") && before?.sets) {
    const was = new Set(before.sets.map(setKey));
    const changed = sets.filter((s) => !was.has(setKey(s)));
    const gone = before.sets.filter((s) => !new Set(sets.map(setKey)).has(setKey(s)));
    if (!changed.length && !gone.length) {
      console.log(`Set list unchanged since the last sync; nothing to do (${requests} request).`);
      return;
    }
    console.log(`Changed sets: ${[...changed, ...gone].map((s) => `${s.name} (${s.cardsCount})`).join(", ")}. Re-syncing.`);
  }

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

  const after = { game: GAME, syncedAt: Math.floor(Date.now() / 1000), sets, cards } as Snapshot;
  fs.writeFileSync(OUT, JSON.stringify(after, null, 0) + "\n");
  console.log(`\n\nWrote ${cards.length} cards to ${path.relative(ROOT, OUT)} using ${requests} requests.`);

  const summary = option("summary");
  if (summary) fs.writeFileSync(summary, describeChanges(before, after) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
