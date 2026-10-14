/**
 * Replay labeled scans (data/eval/) through the real pipeline (read, retrieve, choose)
 * and report accuracy, second-pass rate, latency and measured cost for one model setup.
 *
 *   npx tsx scripts/eval.ts                         # dry run: counts samples, estimates cost
 *   npx tsx scripts/eval.ts --yes                   # run with the app defaults
 *   npx tsx scripts/eval.ts --yes --model claude-sonnet-5-5 --chooser-model claude-sonnet-5-5 --effort low
 *
 * Every run spends real API money (roughly 1-3 cents per sample on Opus 5.5), so it
 * only runs with --yes. Pricing is skipped, so no JustTCG quota is used.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Load .env.local before the Anthropic client is created.
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

type Sample = { id: string; label: { title: string; printingId: string | null; game: string | null } };

async function main() {
  const dir = path.resolve(ROOT, arg("dir") ?? "data/eval");
  const limit = Number(arg("limit") ?? Infinity);
  const samples: Sample[] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Sample)
    .slice(0, limit);

  const { identifyCard, usageLog, MODEL, CHOOSER_MODEL } = await import("../lib/claude");
  const { matchCard } = await import("../lib/pipeline");
  const { normalizeTitle } = await import("../lib/catalog/match");

  const model = arg("model") ?? MODEL;
  const chooserModel = arg("chooser-model") ?? CHOOSER_MODEL;
  const effort = (arg("effort") ?? "low") as "low" | "medium" | "high";
  console.log(`${samples.length} samples · read: ${model} (${effort}) · choose: ${chooserModel}`);
  if (!samples.length) return console.log(`No samples in ${path.relative(ROOT, dir)}. Save some from the app first.`);
  if (!process.argv.includes("--yes")) {
    return console.log(`Dry run. Estimated cost on Opus 5.5: ~$${(samples.length * 0.01).toFixed(2)}–$${(samples.length * 0.03).toFixed(2)}. Re-run with --yes.`);
  }

  const rows: { id: string; title: boolean; printing: boolean | null; method: string; ms: number; cost: number }[] = [];
  for (const s of samples) {
    const image = fs.readFileSync(path.join(dir, `${s.id}.jpg`)).toString("base64");
    const before = usageLog.length;
    const t = Date.now();
    let got = "(error)";
    let topId: string | null = null;
    let method = "error";
    try {
      const id = await identifyCard(image, { model, effort });
      const { match } = await matchCard(id, image, { price: false, chooser: { model: chooserModel, effort } });
      const top = match?.printings[0];
      topId = top?.id ?? null;
      method = match?.method ?? "no match";
      got = match?.exactName && match.method !== "ranked" && top ? top.name : id.subtitle ? `${id.title} - ${id.subtitle}` : (id.title ?? "(unread)");
    } catch (err) {
      console.warn(`  ${s.id}: ${err instanceof Error ? err.message : err}`);
    }
    const cost = usageLog.slice(before).reduce((sum, u) => sum + (u.cost ?? 0), 0);
    const row = {
      id: s.id,
      title: normalizeTitle(got) === normalizeTitle(s.label.title),
      printing: s.label.printingId ? topId === s.label.printingId : null,
      method,
      ms: Date.now() - t,
      cost,
    };
    rows.push(row);
    console.log(
      `${row.title ? "✓" : "✗"} ${row.printing === null ? "·" : row.printing ? "✓" : "✗"}  ${s.label.title.padEnd(36).slice(0, 36)} got "${got}" [${method}] ${row.ms}ms $${cost.toFixed(4)}`,
    );
  }

  const n = rows.length;
  const labeled = rows.filter((r) => r.printing !== null);
  const pct = (x: number, of: number) => (of ? `${Math.round((100 * x) / of)}%` : "n/a");
  console.log("\n─ summary ─");
  console.log(`title accuracy     ${pct(rows.filter((r) => r.title).length, n)} (${n})`);
  console.log(`printing accuracy  ${pct(labeled.filter((r) => r.printing).length, labeled.length)} (${labeled.length} labeled)`);
  console.log(`second pass used   ${pct(rows.filter((r) => r.method === "chosen" || r.method === "ranked").length, n)}`);
  console.log(`avg latency        ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / n)} ms`);
  console.log(`avg cost per scan  $${(rows.reduce((s, r) => s + r.cost, 0) / n).toFixed(4)}  (total $${rows.reduce((s, r) => s + r.cost, 0).toFixed(4)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
