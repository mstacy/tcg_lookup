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
  /** Best guess at the set from its symbol, frame and layout. Ranking hint only, never treated as read. */
  setNameGuess: string | null;
};

export type PriceVariant = {
  condition: string;
  printing: string;
  /** USD; null when the market has no current report for this variant. */
  price: number | null;
  /** Unix seconds. */
  lastUpdated: number | null;
};

/** One real printing of a card from a catalog (Scryfall or JustTCG), with its prices. */
export type CardPrinting = {
  /** Catalog id: Scryfall id for Magic, JustTCG card id otherwise. */
  id: string;
  name: string;
  setName: string | null;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  imageUrl: string | null;
  /** Card page (Scryfall or TCGplayer). */
  url: string | null;
  tcgplayerId: string | null;
  scryfallId: string | null;
  variants: PriceVariant[];
  priceSource: string | null;
  /** Set when prices come from the catalog snapshot rather than a fresh lookup (Unix seconds). */
  priceAsOf: number | null;
  /** True when fuller (per-condition) prices can be fetched on demand from /api/price. */
  canRefinePrice: boolean;
};

export type CardMatch = {
  /**
   * exact: set/number or a unique name pinned one printing.
   * chosen: several matched and Claude picked one by comparing the image.
   * ranked: best guess; the user should check the set dropdown.
   */
  method: "exact" | "chosen" | "ranked";
  /** Candidate printings, best first. */
  printings: CardPrinting[];
  /** True when the catalog lists a card with exactly the name that was read. */
  exactName: boolean;
  /** Where the candidates came from, e.g. "Scryfall" or "JustTCG". */
  catalog: string;
};

export type IdentifyResponse = {
  identification: Identification;
  match: CardMatch | null;
  /** Why pricing or matching is missing (no catalog, quota used up, ...), when it is. */
  pricingError: string | null;
  /** "client" when served from this device's 24h scan cache without calling the server. */
  cache: "none" | "client";
  scannedAt: number;
};
