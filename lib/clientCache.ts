"use client";

import type { CardFeatures } from "./cardMatcher";
import type { Detector } from "./detector";
import { hammingDistance } from "./fingerprint";
import type { IdentifyResponse } from "./types";

const STORAGE_KEY = "tcg:scans:v2"; // v2: catalog match shape
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 80; // ~30 KB each (mostly ORB descriptors)
const MAX_CANDIDATES = 10; // ORB-matched in the detector, which also enforces a time budget

type Entry = { hash: string; features: CardFeatures; response: IdentifyResponse; expiresAt: number };

function load(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries: Entry[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    return entries.filter((e) => e.expiresAt > now && e.features);
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  let kept = entries.slice(-MAX_ENTRIES);
  // On quota errors, drop the oldest entries until it fits.
  while (kept.length) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
      return;
    } catch {
      kept = kept.slice(Math.ceil(kept.length / 4));
    }
  }
}

/**
 * Find a scan of the same card from the last 24 hours on this device.
 * The hash only orders candidates (likeliest first); the ORB match makes the decision.
 */
export async function findCachedScan(detector: Detector, hash: string, features: CardFeatures): Promise<IdentifyResponse | null> {
  const match = await findMatch(detector, load(), hash, features);
  return match ? { ...match.response, cache: "client" } : null;
}

async function findMatch(detector: Detector, entries: Entry[], hash: string, features: CardFeatures): Promise<Entry | null> {
  const candidates = entries
    .map((entry) => ({ entry, distance: hammingDistance(entry.hash, hash) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.entry);
  if (!candidates.length) return null;
  const index = await detector.match(features, candidates.map((c) => c.features));
  return index >= 0 ? candidates[index] : null;
}

/** Store a scan, replacing any cached entry for the same card (e.g. after a forced rescan). */
export async function cacheScan(detector: Detector, hash: string, features: CardFeatures, response: IdentifyResponse): Promise<void> {
  const entries = load();
  const previous = await findMatch(detector, entries, hash, features);
  const kept = previous ? entries.filter((e) => e !== previous) : entries;
  kept.push({ hash, features, response, expiresAt: Date.now() + TTL_MS });
  save(kept);
}

export function clearScanCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
