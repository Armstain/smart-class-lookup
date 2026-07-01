import * as fs from "fs";
import { arbitraryValueBase } from "./classParser";
import type { FileIndexEntry, NearMatch, SearchResult } from "./types";

const MAX_LOCATIONS_PER_RESULT = 12;
// Credit given for an arbitrary-value class that matches on utility+variant but differs
// only in the bracketed value (e.g. w-[120px] vs w-[124px]) — less than a full match.
const NEAR_MATCH_WEIGHT = 0.7;

function getOrLoadSource(entry: FileIndexEntry): string {
  if (entry.source !== undefined) {
    return entry.source;
  }
  try {
    entry.source = fs.readFileSync(entry.file, "utf8");
    return entry.source;
  } catch {
    return "";
  }
}

export function searchTextInFile(
  query: string,
  entry: FileIndexEntry
): SearchResult | null {
  const source = getOrLoadSource(entry);
  if (!source) {
    return null;
  }

  const queryLower = query.toLowerCase();
  const sourceLower = source.toLowerCase();

  const locations: any[] = [];
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineLower = lineText.toLowerCase();
    let index = lineLower.indexOf(queryLower);

    while (index !== -1) {
      locations.push({
        file: entry.file,
        line: i,
        column: index,
        context: lineText.trim().slice(0, 140),
      });
      index = lineLower.indexOf(queryLower, index + 1);
    }
  }

  if (locations.length === 0) {
    return null;
  }

  return {
    file: entry.file,
    matchedCount: locations.length,
    totalInputCount: 1,
    score: 1.0,
    matchedClasses: [query],
    unmatchedClasses: [],
    nearMatches: [],
    locations: locations.slice(0, MAX_LOCATIONS_PER_RESULT),
    maxLineMatches: locations.length,
  };
}

export function scoreFile(
  inputClasses: string[],
  entry: FileIndexEntry
): SearchResult | null {
  if (inputClasses.length === 0) {
    return null;
  }

  const matchedClasses: string[] = [];
  const unmatchedClasses: string[] = [];
  const nearMatches: NearMatch[] = [];

  for (const cls of inputClasses) {
    if (entry.classes.has(cls)) {
      matchedClasses.push(cls);
      continue;
    }

    const base = arbitraryValueBase(cls);
    const candidates = base ? entry.arbitraryIndex?.get(base) : undefined;
    if (candidates && candidates.length > 0) {
      nearMatches.push({ input: cls, actual: candidates[0] });
    } else {
      unmatchedClasses.push(cls);
    }
  }

  if (matchedClasses.length === 0 && nearMatches.length === 0) {
    return null;
  }

  const score =
    (matchedClasses.length + nearMatches.length * NEAR_MATCH_WEIGHT) / inputClasses.length;

  const nearMatchActualNames = nearMatches.map((nm) => nm.actual);
  const locations = [...matchedClasses, ...nearMatchActualNames]
    .flatMap((cls) => entry.locations.get(cls) ?? [])
    .slice(0, MAX_LOCATIONS_PER_RESULT);

  // Group matched (+ near-matched) classes by line number to find the maximum matches on any single line
  const lineToMatches = new Map<number, Set<string>>();
  for (const cls of [...matchedClasses, ...nearMatchActualNames]) {
    const locs = entry.locations.get(cls) ?? [];
    for (const loc of locs) {
      let set = lineToMatches.get(loc.line);
      if (!set) {
        set = new Set();
        lineToMatches.set(loc.line, set);
      }
      set.add(cls);
    }
  }

  let maxLineMatches = 0;
  for (const matchSet of lineToMatches.values()) {
    if (matchSet.size > maxLineMatches) {
      maxLineMatches = matchSet.size;
    }
  }

  return {
    file: entry.file,
    matchedCount: matchedClasses.length,
    totalInputCount: inputClasses.length,
    score,
    matchedClasses,
    unmatchedClasses,
    nearMatches,
    locations,
    maxLineMatches,
  };
}

export function rankFiles(
  inputClasses: string[],
  index: Map<string, FileIndexEntry>,
  options: { minScore?: number; maxResults?: number; rawInput?: string } = {}
): SearchResult[] {
  const minScore = options.minScore ?? 0;
  const resultsMap = new Map<string, SearchResult>();

  // 1. Class-based lookup
  for (const entry of index.values()) {
    const result = scoreFile(inputClasses, entry);
    if (result && result.score >= minScore) {
      resultsMap.set(entry.file, result);
    }
  }

  // 2. Substring text search fallback/boost
  const rawInput = options.rawInput?.trim();
  if (rawInput && rawInput.length >= 2) {
    for (const entry of index.values()) {
      const textResult = searchTextInFile(rawInput, entry);
      if (textResult) {
        const existing = resultsMap.get(entry.file);
        if (existing) {
          // Merge matched text locations with class matches
          const mergedLocations = [...existing.locations];
          for (const loc of textResult.locations) {
            if (!mergedLocations.some((l) => l.line === loc.line)) {
              mergedLocations.push(loc);
            }
          }
          existing.locations = mergedLocations.slice(0, MAX_LOCATIONS_PER_RESULT);
          existing.score = 1.0;
          existing.maxLineMatches = Math.max(existing.maxLineMatches, textResult.matchedCount);
        } else {
          resultsMap.set(entry.file, textResult);
        }
      }
    }
  }

  const results = Array.from(resultsMap.values());

  results.sort((a, b) => {
    if (b.maxLineMatches !== a.maxLineMatches) return b.maxLineMatches - a.maxLineMatches;
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    return a.file.localeCompare(b.file);
  });

  return options.maxResults ? results.slice(0, options.maxResults) : results;
}
