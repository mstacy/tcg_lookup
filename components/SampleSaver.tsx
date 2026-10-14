"use client";

import { useState } from "react";
import { displayName } from "./CardDetails";
import type { IdentifyResponse } from "@/lib/types";

type Props = {
  result: IdentifyResponse;
  /** The crop that produced this result, as base64 JPEG, if still available. */
  getImage: () => string | null;
};

const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none";

/**
 * Development only: label a scan (right or wrong) and save it to data/eval/ for
 * scripts/eval.ts, which measures accuracy and cost across models.
 */
export default function SampleSaver({ result, getImage }: Props) {
  const [open, setOpen] = useState(false);
  const [correct, setCorrect] = useState(true);
  const [title, setTitle] = useState(displayName(result) ?? "");
  const [printingId, setPrintingId] = useState(result.match?.printings[0]?.id ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const printings = result.match?.printings ?? [];

  const save = async () => {
    const image = getImage();
    if (!image) return setStatus("The crop for this scan is no longer available.");
    const label = correct
      ? { title: displayName(result) ?? "", printingId: result.match?.printings[0]?.id ?? null, game: result.identification.game }
      : { title, printingId: printingId || null, game: result.identification.game };
    setStatus("Saving…");
    const res = await fetch("/api/dev/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, result, label }),
    });
    setStatus(res.ok ? `Saved ✓ (${(await res.json()).saved})` : "Save failed.");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="self-start text-xs text-neutral-500 underline hover:text-neutral-300">
        Save as test sample (dev)
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-neutral-700 p-3 text-sm">
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={correct} onChange={() => setCorrect(true)} /> App was right
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!correct} onChange={() => setCorrect(false)} /> App was wrong
        </label>
      </div>
      {!correct && (
        <>
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Correct card name" aria-label="Correct card name" />
          <select className={inputClass} value={printingId} onChange={(e) => setPrintingId(e.target.value)} aria-label="Correct printing">
            <option value="">Correct printing not listed / unknown</option>
            {printings.map((p) => (
              <option key={p.id} value={p.id}>
                {[p.name, p.setName, p.number && `#${p.number}`].filter(Boolean).join(" · ")}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="flex items-center gap-3">
        <button onClick={save} className="rounded-full bg-sky-600 px-3 py-1 text-white hover:bg-sky-500">
          Save sample
        </button>
        {status && <span className="text-xs text-neutral-400">{status}</span>}
      </div>
    </div>
  );
}
