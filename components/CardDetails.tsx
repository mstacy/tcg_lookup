"use client";

import { useState } from "react";
import type { CardPrinting, IdentifyResponse } from "@/lib/types";

/** Display order for conditions; anything unrecognised sorts after these. */
export const CONDITION_ORDER = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

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

/** Near Mint price of a printing's default finish, for compact displays like scan history. */
export function headlinePrice(result: IdentifyResponse): number | null {
  const variants = result.pricing?.printings[0]?.variants ?? [];
  const nm = variants.filter((v) => v.condition === "Near Mint" && v.price !== null);
  return (nm.find((v) => v.printing === "Normal") ?? nm[0])?.price ?? null;
}

type Props = {
  result: IdentifyResponse;
  /** Preferred condition; kept by the parent so it persists across scans. */
  condition: string;
  onConditionChange: (condition: string) => void;
};

const selectClass =
  "w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none";

export default function CardDetails({ result, condition, onConditionChange }: Props) {
  const { pricing, verification, identification } = result;
  const printings = pricing?.printings ?? [];
  // Keyed by scan, so a new result starts on its best-match printing.
  const [choice, setChoice] = useState<{ scannedAt: number; printingId: string | null; finish: string | null }>({
    scannedAt: result.scannedAt,
    printingId: null,
    finish: null,
  });
  const current = choice.scannedAt === result.scannedAt ? choice : { scannedAt: result.scannedAt, printingId: null, finish: null };

  const printing: CardPrinting | undefined = printings.find((p) => p.id === current.printingId) ?? printings[0];
  const finishes = [...new Set(printing?.variants.map((v) => v.printing) ?? [])];
  const finish = current.finish && finishes.includes(current.finish) ? current.finish : finishes.includes("Normal") ? "Normal" : finishes[0];
  const conditions = sortConditions(printing?.variants.filter((v) => v.printing === finish).map((v) => v.condition) ?? []);
  const activeCondition = conditions.includes(condition) ? condition : conditions[0];
  const variant = printing?.variants.find((v) => v.printing === finish && v.condition === activeCondition);

  const setName = printing?.setName ?? verification?.setName ?? identification.setCode;
  const number = printing?.number ?? verification?.number ?? identification.collectorNumber;
  const rarity = printing?.rarity ?? verification?.rarity;

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        <dt className="text-neutral-500">Set</dt>
        <dd className="min-w-0">
          {printings.length > 1 ? (
            <select
              className={selectClass}
              value={printing?.id}
              onChange={(e) => setChoice({ ...current, printingId: e.target.value })}
              aria-label="Set"
            >
              {printings.map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.setName ?? "Unknown set", p.number && `#${p.number}`].filter(Boolean).join(" · ")}
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

      {pricing && printing && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-3xl font-bold tabular-nums">
              {variant?.price != null ? usd.format(variant.price) : "No price"}
            </span>
            <span className="text-xs text-neutral-500">market price</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {conditions.length > 1 ? (
              <select
                className={selectClass}
                value={activeCondition}
                onChange={(e) => onConditionChange(e.target.value)}
                aria-label="Condition"
              >
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
            {pricing.source}
            {variant?.lastUpdated ? ` · updated ${timeAgo(variant.lastUpdated)}` : ""}
            {printing.tcgplayerId && (
              <>
                {" · "}
                <a
                  href={`https://www.tcgplayer.com/product/${printing.tcgplayerId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:underline"
                >
                  TCGplayer
                </a>
              </>
            )}
          </p>
          {!pricing.confident && (
            <p className="mt-2 text-xs text-amber-300">
              {printings.length > 1
                ? "Couldn't read the set from the card. Check the set above."
                : "Couldn't read the set from the card, so this may be a different printing."}
            </p>
          )}
        </div>
      )}

      {result.pricingError && <p className="text-xs text-neutral-500">{result.pricingError}</p>}
    </div>
  );
}
