"use client";

import type { IdentifyResponse } from "@/lib/types";

type Props = {
  result: IdentifyResponse | null;
  history: IdentifyResponse[];
  error: string | null;
  busy: boolean;
  onRescan: () => void;
  onSelect: (result: IdentifyResponse) => void;
};

const CONFIDENCE_STYLES = {
  high: "bg-emerald-500/15 text-emerald-300",
  medium: "bg-amber-500/15 text-amber-300",
  low: "bg-red-500/15 text-red-300",
};

export default function ResultPanel({ result, history, error, busy, onRescan, onSelect }: Props) {
  const id = result?.identification;
  const verification = result?.verification;

  return (
    <section className="flex flex-col gap-4 overflow-y-auto p-4 md:p-5">
      {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</p>}

      {!result && !error && (
        <p className="text-sm text-neutral-400">
          {busy ? "Identifying…" : "Hold a card inside the frame. It scans automatically once it's steady, or tap Scan."}
        </p>
      )}

      {id && !id.isCard && (
        <div>
          <p className="text-lg font-semibold">No trading card detected</p>
          <p className="text-sm text-neutral-400">Fill more of the frame with the card and avoid glare.</p>
        </div>
      )}

      {id?.isCard && (
        <div className="flex gap-4">
          {verification?.imageUrl && (
            // External card art from the verifier; next/image would need remote host config.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={verification.imageUrl}
              alt={verification.name}
              className="h-36 w-auto shrink-0 rounded-lg shadow-lg"
            />
          )}
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="text-2xl font-bold leading-tight break-words">
              {verification?.name ?? id.title ?? "Title unreadable"}
            </h2>
            {verification && id.title && verification.name.toLowerCase() !== id.title.toLowerCase() && (
              <p className="text-xs text-neutral-400">Read as “{id.title}”</p>
            )}
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-300">{id.game ?? "Unknown game"}</span>
              <span className={`rounded-full px-2 py-0.5 ${CONFIDENCE_STYLES[id.confidence]}`}>{id.confidence} confidence</span>
              {verification ? (
                <a
                  href={verification.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300 hover:underline"
                >
                  ✓ {verification.source}
                </a>
              ) : (
                <span className="rounded-full bg-neutral-500/15 px-2 py-0.5 text-neutral-400">unverified</span>
              )}
              {result?.cache !== "none" && (
                <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-violet-300">cached</span>
              )}
            </div>
            {(id.cardType || id.setCode || verification?.setName) && (
              <p className="text-sm text-neutral-400">
                {[id.cardType, verification?.setName ?? id.setCode, id.collectorNumber && `#${id.collectorNumber}`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        </div>
      )}

      {result && (
        <button
          onClick={onRescan}
          disabled={busy}
          className="self-start rounded-full border border-neutral-700 px-4 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
        >
          Rescan (skip cache)
        </button>
      )}

      {history.length > 0 && (
        <div className="border-t border-neutral-800 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Recent scans</h3>
          <ul className="flex flex-col gap-1">
            {history.map((h) => (
              <li key={h.scannedAt}>
                <button
                  onClick={() => onSelect(h)}
                  className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-neutral-800"
                >
                  <span className="truncate">
                    {h.verification?.name ?? h.identification.title ?? (h.identification.isCard ? "Unreadable" : "Not a card")}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">{h.identification.game ?? ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
