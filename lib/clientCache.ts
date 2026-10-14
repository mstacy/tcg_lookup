"use client";

import { isSameCard, type CardFeatures } from "./cardMatcher";
import { hammingDistance } from "./fingerprint";
import type { IdentifyResponse } from "./types";

const STORAGE_KEY = "tcg:scans";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 80; // ~30 KB each (mostly ORB descriptors)
const MATCH_BUDGET_MS = 600; // ORB match is ~30 ms per candidate

type Entry = { hash: string; features: CardFeatures; response: IdentifyResponse; expiresAt: number };

/* eslint-disable @typescript-eslint/no-explicit-any */

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
export function findCachedScan(cv: any, hash: string, features: CardFeatures): IdentifyResponse | null {
  const match = findMatch(cv, load(), hash, features);
  return match ? { ...match.response, cache: "client" } : null;
}

function findMatch(cv: any, entries: Entry[], hash: string, features: CardFeatures): Entry | null {
  const candidates = entries
    .map((entry) => ({ entry, distance: hammingDistance(entry.hash, hash) }))
    .sort((a, b) => a.distance - b.distance);

  const deadline = performance.now() + MATCH_BUDGET_MS;
  for (const { entry } of candidates) {
    if (isSameCard(cv, features, entry.features)) return entry;
    if (performance.now() > deadline) break;
  }
  return null;
}

/** Store a scan, replacing any cached entry for the same card (e.g. after a forced rescan). */
export function cacheScan(cv: any, hash: string, features: CardFeatures, response: IdentifyResponse): void {
  const entries = load();
  const previous = findMatch(cv, entries, hash, features);
  const kept = previous ? entries.filter((e) => e !== previous) : entries;
  kept.push({ hash, features, response, expiresAt: Date.now() + TTL_MS });
  save(kept);
}

export function clearScanCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
