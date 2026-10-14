export type Point = { x: number; y: number };

/** Corners ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type Identification = {
  isCard: boolean;
  game: string | null;
  title: string | null;
  /** Subtitle/epithet printed with the name (Cyberpunk TCG, Lorcana), if any. */
  subtitle: string | null;
  confidence: "high" | "medium" | "low";
  cardType: string | null;
  setCode: string | null;
  collectorNumber: string | null;
};

export type Verification = {
  source: string;
  name: string;
  url: string | null;
  imageUrl: string | null;
  setName: string | null;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  /** Scryfall card id; lets JustTCG price this exact printing. */
  scryfallId: string | null;
  /** True when matched by set code + collector number rather than by name alone. */
  exactPrinting: boolean;
  /** Scryfall's TCGplayer market prices (USD), the fallback when JustTCG is unavailable. */
  prices: { usd: number | null; usdFoil: number | null } | null;
};

export type PriceVariant = {
  condition: string;
  printing: string;
  /** USD; null when the market has no current report for this variant. */
  price: number | null;
  /** Unix seconds. */
  lastUpdated: number | null;
};

/** One printing of a card (a specific set + number), with a price per condition and finish. */
export type CardPrinting = {
  id: string;
  name: string;
  setName: string | null;
  number: string | null;
  rarity: string | null;
  tcgplayerId: string | null;
  variants: PriceVariant[];
};

export type Pricing = {
  source: string;
  /** Candidate printings, best match first. */
  printings: CardPrinting[];
  /** False when the set/number couldn't be matched and the first printing is a best guess. */
  confident: boolean;
  /** True when the pricing source lists a card with exactly this name (confirms the reading). */
  exactName: boolean;
};

export type IdentifyResponse = {
  identification: Identification;
  verification: Verification | null;
  pricing: Pricing | null;
  /** Why pricing is missing (no API key, quota used up, ...), when it is. */
  pricingError: string | null;
  /** "client" when served from this device's 24h scan cache without calling the server. */
  cache: "none" | "client";
  scannedAt: number;
};
