import type { Verification } from "../types";

type ScryfallCard = {
  name: string;
  scryfall_uri: string;
  set_name: string;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
};

/** Fuzzy-match a card name against Scryfall. Returns null when nothing matches. */
export async function verifyMagic(title: string): Promise<Verification | null> {
  const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(title)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "tcg-lookup/0.1", Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);

  const card = (await res.json()) as ScryfallCard;
  return {
    source: "Scryfall",
    name: card.name,
    url: card.scryfall_uri,
    imageUrl: card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null,
    setName: card.set_name,
  };
}
