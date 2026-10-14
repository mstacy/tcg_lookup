export type Point = { x: number; y: number };

/** Corners ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type Identification = {
  isCard: boolean;
  game: string | null;
  title: string | null;
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
};

export type IdentifyResponse = {
  identification: Identification;
  verification: Verification | null;
  /** "client" when served from this device's 24h scan cache without calling the server. */
  cache: "none" | "client";
  scannedAt: number;
};
