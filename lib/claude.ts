import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { CardPrinting, Identification } from "./types";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
export const CHOOSER_MODEL = process.env.ANTHROPIC_CHOOSER_MODEL ?? MODEL;

const IdentificationSchema = z.object({
  isCard: z.boolean().describe("True only if the image shows a trading card game card."),
  game: z
    .string()
    .nullable()
    .describe('Game name, e.g. "Magic: The Gathering", "Cyberpunk TCG", "Pokémon", "Yu-Gi-Oh!". Null if not a card or unknown.'),
  title: z
    .string()
    .nullable()
    .describe("The card's printed name exactly as printed. Null if it cannot be read."),
  subtitle: z
    .string()
    .nullable()
    .describe("Subtitle or epithet printed with the name, if the card has one (e.g. Cyberpunk TCG: 'Mama's Favorite'). Null otherwise."),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the title reading."),
  cardType: z.string().nullable().describe("Type line or card category if legible, e.g. 'Legendary Creature — Elf'."),
  setCode: z.string().nullable().describe("Set code if legible, e.g. 'M21' or 'MKM'."),
  collectorNumber: z.string().nullable().describe("Collector number if legible, e.g. '123' or '045/271'."),
  setNameGuess: z
    .string()
    .nullable()
    .describe("Your best guess at the set's full name from its set symbol, frame style and layout, e.g. 'Seventh Edition'. Null if you can't tell."),
});

const SYSTEM_PROMPT = `You identify trading card game (TCG) cards from camera photos.

The most important output is the card's title: its printed name, usually the largest text on the card. Transcribe it exactly as printed, including punctuation and capitalization. Never invent or "correct" a title to a card you think it might be. If the name is unreadable (blur, glare, cropped), return null and lower the confidence.

Layout hints:
- Magic: The Gathering: name in the top-left of the frame bar, mana cost top-right, type line in the middle, set symbol right of the type line, collector number and set code bottom-left.
- Cyberpunk TCG (Cyberpunk 2077 trading card game): the card name is the largest text, usually with a smaller subtitle (epithet) next to or under it, e.g. "Jackie Welles" / "Mama's Favorite". Return the name as the title and the epithet as the subtitle. Card types include Legends, Units, Gear and Programs.
- Other games (Pokémon, Yu-Gi-Oh!, Lorcana, One Piece, Flesh and Blood, etc.) are fine. Name the game if you recognize it, otherwise return null for game.

After the title, the set code and collector number matter most: they identify the exact printing, which determines the price. Read them if they're legible (they're usually small print along the bottom edge), but never guess them. Separately, give your best guess at the set's name from the set symbol and frame style in setNameGuess; that one may be a guess.

If the image does not show a TCG card (e.g. a sports card, a book, a phone, an empty scene), set isCard to false and leave the other fields null.`;

const client = new Anthropic();

// USD per million tokens: [input, output, cache read, cache write (5-minute TTL)].
// Cache rates use the standard 0.1x (read) and 1.25x (write) of input where unlisted.
const RATES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type CallOptions = { model?: string; effort?: Effort };

export type UsageRecord = { label: string; model: string; usage: Usage; cost: number | null };
/** Every call's usage, for scripts (e.g. the eval) that need measured cost. Capped. */
export const usageLog: UsageRecord[] = [];

/** Log token usage and estimated cost per call, so cost per scan is measured, not guessed. */
function logUsage(label: string, model: string, usage: Usage) {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const rates = RATES[model];
  const cost = rates
    ? (usage.input_tokens * rates[0] + usage.output_tokens * rates[1] + read * rates[2] + write * rates[3]) / 1e6
    : null;
  usageLog.push({ label, model, usage, cost });
  if (usageLog.length > 1000) usageLog.shift();
  console.log(
    `[claude] ${label} ${model} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${read} cache_write=${write}` +
      (cost !== null ? ` cost=${cost.toFixed(5)}` : ""),
  );
}

export class IdentifyError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export async function identifyCard(jpegBase64: string, opts: CallOptions = {}): Promise<Identification> {
  const response = await client.beta.messages.parse({
    model: opts.model ?? MODEL,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "low", format: betaZodOutputFormat(IdentificationSchema) },
    // The prompt + output schema (~1,650 tokens) is identical on every scan: cache it.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
          { type: "text", text: "Identify this card." },
        ],
      },
    ],
  });

  logUsage("identify", response.model, response.usage);

  if (response.stop_reason === "refusal") {
    throw new IdentifyError("The model declined to identify this image.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new IdentifyError("The model response was cut off. Try again.");
  }
  if (!response.parsed_output) {
    throw new IdentifyError("Could not parse the model response.");
  }
  return response.parsed_output;
}

const CHOOSER_PROMPT = `You match a photographed trading card to one entry in a list of real catalog printings of that card.

Compare what's visible on the photo against each candidate: the exact name and subtitle, set symbol and set code, collector number, rarity, frame style, and (when candidate images are given) the artwork. Pick the candidate that is the same printing as the photo. If none of them is, or you can't tell, answer "none". Don't pick one just because it's first.`;

/**
 * Second pass when retrieval is ambiguous: show Claude the scan together with the real
 * candidates (and their images, when available) and have it pick one by id.
 * Returns the chosen candidate id, or null for "none".
 */
export async function chooseCandidate(
  jpegBase64: string,
  candidates: CardPrinting[],
  thumbnails: (string | null)[] = [],
  opts: CallOptions = {},
): Promise<string | null> {
  const ids = candidates.map((c) => c.id);
  const Choice = z.object({
    candidateId: z.enum([...ids, "none"] as unknown as [string, ...string[]]).describe("The id of the matching candidate, or 'none'."),
    reason: z.string().describe("One short sentence on what decided it."),
  });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: "Photographed card:" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
  ];
  candidates.forEach((c, i) => {
    const line = [c.name, c.setName && `${c.setName}${c.setCode ? ` (${c.setCode})` : ""}`, c.number && `#${c.number}`, c.rarity]
      .filter(Boolean)
      .join(" | ");
    content.push({ type: "text", text: `Candidate ${i + 1}: id=${c.id} | ${line}` });
    const thumb = thumbnails[i];
    if (thumb) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: thumb } });
  });
  content.push({ type: "text", text: "Which candidate is the photographed card?" });

  const response = await client.beta.messages.parse({
    model: opts.model ?? CHOOSER_MODEL,
    max_tokens: 2048,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "low", format: betaZodOutputFormat(Choice) },
    system: CHOOSER_PROMPT,
    messages: [{ role: "user", content }],
  });
  logUsage("choose", response.model, response.usage);

  if (response.stop_reason !== "end_turn" || !response.parsed_output) {
    console.warn(`[claude] choose: no usable answer (${response.stop_reason})`);
    return null;
  }
  console.log(`[claude] choose: ${response.parsed_output.candidateId} (${response.parsed_output.reason})`);
  return response.parsed_output.candidateId === "none" ? null : response.parsed_output.candidateId;
}
