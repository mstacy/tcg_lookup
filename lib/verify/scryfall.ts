import type { Verification } from "../types";

type ScryfallCard = {
  id: string;
  name: string;
  scryfall_uri: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: { usd: string | null; usd_foil: string | null };
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
};

async function getCard(path: string): Promise<ScryfallCard | null> {
  const res = await fetch(`https://api.scryfall.com${path}`, {
    headers: { "User-Agent": "tcg-lookup/0.1", Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
  return (await res.json()) as ScryfallCard;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const toPrice = (v: string | null) => (v ? Number(v) : null);

/**
 * Match a card against Scryfall. With a legible set code and collector number this
 * finds the exact printing (which matters a lot for price); otherwise it falls back
 * to a fuzzy name match, which returns Scryfall's default printing of that name.
 */
export async function verifyMagic(
  title: string,
  hints: { setCode?: string | null; collectorNumber?: string | null } = {},
): Promise<Verification | null> {
  let card: ScryfallCard | null = null;
  let exactPrinting = false;

  const set = hints.setCode?.trim().toLowerCase();
  // "0123/280" -> "123"
  const number = hints.collectorNumber?.trim().replace(/\/.*$/, "").replace(/^0+(?=\d)/, "");
  if (set && number && /^[a-z0-9]{2,6}$/.test(set)) {
    const printing = await getCard(`/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`);
    // Only trust it if the name agrees; a misread number could land on a different card.
    if (printing && compact(printing.name).startsWith(compact(title).slice(0, 10))) {
      card = printing;
      exactPrinting = true;
    }
  }
  card ??= await getCard(`/cards/named?fuzzy=${encodeURIComponent(title)}`);
  if (!card) return null;

  return {
    source: "Scryfall",
    name: card.name,
    url: card.scryfall_uri,
    imageUrl: card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null,
    setName: card.set_name,
    setCode: card.set.toUpperCase(),
    number: card.collector_number,
    rarity: card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1),
    scryfallId: card.id,
    exactPrinting,
    prices: { usd: toPrice(card.prices.usd), usdFoil: toPrice(card.prices.usd_foil) },
  };
}
