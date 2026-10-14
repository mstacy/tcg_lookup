import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Identification } from "./types";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

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
});

const SYSTEM_PROMPT = `You identify trading card game (TCG) cards from camera photos.

The most important output is the card's title: its printed name, usually the largest text on the card. Transcribe it exactly as printed, including punctuation and capitalization. Never invent or "correct" a title to a card you think it might be. If the name is unreadable (blur, glare, cropped), return null and lower the confidence.

Layout hints:
- Magic: The Gathering: name in the top-left of the frame bar, mana cost top-right, type line in the middle, set symbol right of the type line, collector number and set code bottom-left.
- Cyberpunk TCG (Cyberpunk 2077 trading card game): the card name is the largest text, usually with a smaller subtitle (epithet) next to or under it, e.g. "Jackie Welles" / "Mama's Favorite". Return the name as the title and the epithet as the subtitle. Card types include Legends, Units, Gear and Programs.
- Other games (Pokémon, Yu-Gi-Oh!, Lorcana, One Piece, Flesh and Blood, etc.) are fine. Name the game if you recognize it, otherwise return null for game.

After the title, the set code and collector number matter most: they identify the exact printing, which determines the price. Read them if they're legible (they're usually small print along the bottom edge), but never guess them.

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

/** Log token usage and estimated cost per call, so cost per scan is measured, not guessed. */
function logUsage(label: string, model: string, usage: Usage) {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const rates = RATES[model];
  const cost = rates
    ? (usage.input_tokens * rates[0] + usage.output_tokens * rates[1] + read * rates[2] + write * rates[3]) / 1e6
    : null;
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

export async function identifyCard(jpegBase64: string): Promise<Identification> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(IdentificationSchema) },
    system: SYSTEM_PROMPT,
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
