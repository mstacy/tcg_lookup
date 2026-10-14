import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import type { IdentifyResponse } from "@/lib/types";

export const runtime = "nodejs";

export type SampleLabel = {
  /** Correct printed name ("Name - Subtitle" for games with epithets). */
  title: string;
  /** Correct catalog printing id, when known (Scryfall id for Magic, JustTCG id otherwise). */
  printingId: string | null;
  game: string | null;
};

/**
 * Development only: save a scan's crop with the app's answer and a corrected label
 * to data/eval/, building the test set that scripts/eval.ts replays.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json()) as { image?: string; result?: IdentifyResponse; label?: SampleLabel };
  if (!body.image || !/^[A-Za-z0-9+/]+=*$/.test(body.image) || !body.label?.title) {
    return NextResponse.json({ error: "Need image (base64 JPEG) and label.title." }, { status: 400 });
  }

  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), "data/eval");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.jpg`), Buffer.from(body.image, "base64"));
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, savedAt: Date.now(), label: body.label, app: body.result ?? null }, null, 2) + "\n",
  );
  return NextResponse.json({ saved: id });
}
