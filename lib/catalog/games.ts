import { normalizeTitle } from "./match";

/** JustTCG game ids (from GET /v1/games), so no per-instance lookup request is needed. */
const GAMES: Record<string, string> = {
  "magic the gathering": "magic-the-gathering",
  "cyberpunk tcg": "cyberpunk-tcg",
  pokemon: "pokemon",
  "pokemon japan": "pokemon-japan",
  yugioh: "yugioh",
  "disney lorcana": "disney-lorcana",
  "one piece card game": "one-piece-card-game",
  "digimon card game": "digimon-card-game",
  "flesh and blood tcg": "flesh-and-blood-tcg",
  "star wars unlimited": "star-wars-unlimited",
  "union arena": "union-arena",
  "dragon ball super fusion world": "dragon-ball-super-fusion-world",
  "dragon ball super masters": "dragon-ball-super-masters",
  "grand archive tcg": "grand-archive-tcg",
  "gundam card game": "gundam-card-game",
  "sorcery contested realm": "sorcery-contested-realm",
  "riftbound league of legends trading card game": "riftbound-league-of-legends-trading-card-game",
  universus: "universus",
  "hololive official card game": "hololive-official-card-game",
  "palworld official card game": "palworld-official-card-game",
};

const ALIASES: Record<string, string> = {
  mtg: "magic the gathering",
  magic: "magic the gathering",
  "pokemon tcg": "pokemon",
  "pokemon trading card game": "pokemon",
  "yu gi oh": "yugioh",
  "yu gi oh tcg": "yugioh",
  lorcana: "disney lorcana",
  "one piece": "one piece card game",
  "one piece tcg": "one piece card game",
  "flesh and blood": "flesh and blood tcg",
  riftbound: "riftbound league of legends trading card game",
  "cyberpunk 2077 tcg": "cyberpunk tcg",
  "cyberpunk 2077 trading card game": "cyberpunk tcg",
  "cyberpunk trading card game": "cyberpunk tcg",
};

export const MAGIC = "magic-the-gathering";

/** Map the model's game name ("MTG", "Cyberpunk 2077 TCG", ...) to a JustTCG game id. */
export function gameId(game: string | null): string | null {
  if (!game) return null;
  const name = normalizeTitle(game);
  const canonical = ALIASES[name] ?? name;
  if (GAMES[canonical]) return GAMES[canonical];
  // Loose match, shortest name first so "Pokemon" beats "Pokemon Japan".
  const loose = Object.keys(GAMES)
    .filter((g) => g.includes(canonical) || canonical.includes(g))
    .sort((a, b) => a.length - b.length);
  return loose.length ? GAMES[loose[0]] : null;
}
