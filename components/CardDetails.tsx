"use client";

import { useEffect, useState } from "react";
import type { CardPrinting, IdentifyResponse, PriceVariant } from "@/lib/types";

/** Display order for conditions; anything unrecognised sorts after these. */
export const CONDITION_ORDER = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function sortConditions(conditions: string[]) {
  const rank = (c: string) => (CONDITION_ORDER.indexOf(c) + 1 || 99);
  return [...new Set(conditions)].sort((a, b) => rank(a) - rank(b));
}

function timeAgo(unixSeconds: number) {
  const hours = (Date.now() / 1000 - unixSeconds) / 3600;
  if (hours < 1) return "under an hour ago";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Best name for a scan: the matched catalog name when confirmed, else what was read. */
export function displayName(result: IdentifyResponse): string | null {
  const { match, identification: id } = result;
  if (match?.exactName && match.method !== "ranked" && match.printings[0]) return match.printings[0].name;
  if (!id.title) return null;
  return id.subtitle ? `${id.title} - ${id.subtitle}` : id.title;
}

/** Near Mint price of the best match's default finish, for compact displays like scan history. */
export function headlinePrice(result: IdentifyResponse): number | null {
  const variants = result.match?.printings[0]?.variants ?? [];
  const nm = variants.filter((v) => v.condition === "Near Mint" && v.price !== null);
  return (nm.find((v) => v.printing === "Normal") ?? nm[0])?.price ?? null;
}

type Refined = { variants: PriceVariant[]; tcgplayerId: string | null };

type Props = {
  result: IdentifyResponse;
  /** Preferred condition; kept by the parent so it persists across scans. */
  condition: string;
  onConditionChange: (condition: string) => void;
};

const selectClass =
  "w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none";

export default function CardDetails({ result, condition, onConditionChange }: Props) {
  const { match, identification } = result;
  const printings = match?.printings ?? [];
  // Keyed by scan, so a new result starts on its best-match printing.
  const [choice, setChoice] = useState<{ scannedAt: number; printingId: string | null; finish: string | null }>({
    scannedAt: result.scannedAt,
    printingId: null,
    finish: null,
  });
  const current = choice.scannedAt === result.scannedAt ? choice : { scannedAt: result.scannedAt, printingId: null, finish: null };
  // Per-condition prices fetched on demand for printings picked from the dropdown.
  const [refined, setRefined] = useState<Record<string, Refined | "loading" | "error">>({});

  const base: CardPrinting | undefined = printings.find((p) => p.id === current.printingId) ?? printings[0];
  const extra = base ? refined[base.id] : undefined;
  const printing: CardPrinting | undefined =
    base && extra && typeof extra === "object"
      ? { ...base, variants: extra.variants, tcgplayerId: extra.tcgplayerId ?? base.tcgplayerId, priceSource: "JustTCG", priceAsOf: null }
      : base;

  useEffect(() => {
    if (!base?.canRefinePrice || refined[base.id]) return;
    const query = base.scryfallId ? `scryfallId=${base.scryfallId}` : `cardId=${encodeURIComponent(base.id)}`;
    setRefined((r) => ({ ...r, [base.id]: "loading" }));
    fetch(`/api/price?${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: Refined) => setRefined((r) => ({ ...r, [base.id]: data })))
      .catch(() => setRefined((r) => ({ ...r, [base.id]: "error" })));
  }, [base, refined]);

  const finishes = [...new Set(printing?.variants.map((v) => v.printing) ?? [])];
  const finish = current.finish && finishes.includes(current.finish) ? current.finish : finishes.includes("Normal") ? "Normal" : finishes[0];
  const conditions = sortConditions(printing?.variants.filter((v) => v.printing === finish).map((v) => v.condition) ?? []);
  const activeCondition = conditions.includes(condition) ? condition : conditions[0];
  const variant = printing?.variants.find((v) => v.printing === finish && v.condition === activeCondition);

  // When the candidates are different cards (e.g. same character, other subtitles), say which.
  const namesDiffer = new Set(printings.map((p) => p.name)).size > 1;
  const setName = printing?.setName ?? identification.setCode;
  const number = printing?.number ?? identification.collectorNumber;
  const rarity = printing?.rarity && printing.rarity !== "None" ? printing.rarity : null;
  const link = printing?.tcgplayerId ? `https://www.tcgplayer.com/product/${printing.tcgplayerId}` : printing?.url;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        {printing?.imageUrl && (
          // External card art from the catalog; next/image would need remote host config.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={printing.imageUrl} alt={printing.name} className="h-32 w-auto shrink-0 self-start rounded-lg shadow-lg" />
        )}
        <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {namesDiffer && printing && (
            <>
              <dt className="text-neutral-500">Card</dt>
              <dd className="text-neutral-100">{printing.name}</dd>
            </>
          )}
          <dt className="text-neutral-500">Set</dt>
          <dd className="min-w-0">
            {printings.length > 1 ? (
              <select
                className={selectClass}
                value={base?.id}
                onChange={(e) => setChoice({ ...current, printingId: e.target.value })}
                aria-label="Set"
              >
                {printings.map((p) => (
                  <option key={p.id} value={p.id}>
                    {[namesDiffer && p.name, p.setName ?? "Unknown set", p.number && `#${p.number}`].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-neutral-100">{setName ?? "—"}</span>
            )}
          </dd>
          <dt className="text-neutral-500">Number</dt>
          <dd className="text-neutral-100">{number ?? "—"}</dd>
          <dt className="text-neutral-500">Rarity</dt>
          <dd className="text-neutral-100">{rarity ?? "—"}</dd>
        </dl>
      </div>

      {match?.method === "chosen" && (
        <p className="text-xs text-sky-300">Matched by comparing the photo with the possible printings.</p>
      )}
      {match?.method === "ranked" && (
        <p className="text-xs text-amber-300">
          {printings.length > 1
            ? "Couldn't pin down the exact printing. Check the set above."
            : "Couldn't confirm the set from the card, so this may be a different printing."}
        </p>
      )}

      {printing && printing.variants.length > 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-3xl font-bold tabular-nums">
              {variant?.price != null ? usd.format(variant.price) : "No price"}
            </span>
            <span className="text-xs text-neutral-500">{extra === "loading" ? "getting prices…" : "market price"}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {conditions.length > 1 ? (
              <select className={selectClass} value={activeCondition} onChange={(e) => onConditionChange(e.target.value)} aria-label="Condition">
                {conditions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <span className="self-center text-sm text-neutral-300">{activeCondition ?? "—"}</span>
            )}
            {finishes.length > 1 ? (
              <select
                className={selectClass}
                value={finish}
                onChange={(e) => setChoice({ ...current, finish: e.target.value })}
                aria-label="Printing"
              >
                {finishes.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : (
              <span className="self-center text-sm text-neutral-300">{finish}</span>
            )}
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            {printing.priceSource}
            {printing.priceAsOf
              ? ` · as of ${dateFormat.format(new Date(printing.priceAsOf * 1000))}`
              : variant?.lastUpdated
                ? ` · updated ${timeAgo(variant.lastUpdated)}`
                : ""}
            {link && (
              <>
                {" · "}
                <a href={link} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                  {printing.tcgplayerId ? "TCGplayer" : "Scryfall"}
                </a>
              </>
            )}
          </p>
        </div>
      )}
      {printing && printing.variants.length === 0 && extra !== "loading" && (
        <p className="text-xs text-neutral-500">No price listing for this printing.</p>
      )}

      {result.pricingError && <p className="text-xs text-neutral-500">{result.pricingError}</p>}
    </div>
  );
}
