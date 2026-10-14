import { PricingError, searchCards } from "../pricing/justtcg";
import type { CardPrinting, Identification } from "../types";
import { gameId as toGameId, MAGIC } from "./games";
import { fullName, rankCandidates, type Ranked, type Reading } from "./match";
import * as scryfall from "./scryfall";
import { hasSnapshot, snapshotPrintings } from "./snapshot";

export type Retrieval = {
  gameId: string;
  /** Label for where candidates came from. */
  catalog: string;
  ranked: Ranked<CardPrinting>;
};

function readingOf(id: Identification): Reading {
  return { title: id.title!, subtitle: id.subtitle, setCode: id.setCode, number: id.collectorNumber, setNameGuess: id.setNameGuess };
}

/**
 * Retrieve real catalog cards matching what was read off the scan, ranked.
 * Magic: Scryfall (exact set + number, else every printing of the name).
 * Snapshot games (Cyberpunk TCG): the whole local catalog.
 * Other JustTCG games: a name search.
 */
export async function retrieveCandidates(id: Identification): Promise<Retrieval> {
  const gameId = toGameId(id.game);
  if (!gameId) throw new PricingError(`No card catalog for ${id.game ?? "this game"} yet.`);
  const reading = readingOf(id);

  if (gameId === MAGIC) {
    const exact = await scryfall.exactPrinting(reading.title, reading.setCode, reading.number);
    if (exact) {
      return { gameId, catalog: "Scryfall", ranked: { candidates: [scryfall.toPrinting(exact)], decision: "exact", exactName: true } };
    }
    const printings = (await scryfall.allPrintings(reading.title)).map(scryfall.toPrinting);
    // Scryfall already resolved a fuzzy name, so rank on its canonical name.
    const canonical = printings[0] ? { ...reading, title: printings[0].name.split(" // ")[0], subtitle: null } : reading;
    return { gameId, catalog: "Scryfall", ranked: rankCandidates(printings, canonical, { limit: 60 }) };
  }

  if (hasSnapshot(gameId)) {
    return { gameId, catalog: "JustTCG", ranked: rankCandidates(snapshotPrintings(gameId), reading) };
  }

  const found = await searchCards(gameId, fullName(reading.title, reading.subtitle));
  return { gameId, catalog: "JustTCG", ranked: rankCandidates(found, reading) };
}
