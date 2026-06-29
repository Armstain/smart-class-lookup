import type { FileIndexEntry, SearchResult } from "./types";

const MAX_LOCATIONS_PER_RESULT = 12;

export function scoreFile(
  inputClasses: string[],
  entry: FileIndexEntry
): SearchResult | null {
  if (inputClasses.length === 0) {
    return null;
  }

  const matchedClasses: string[] = [];
  const unmatchedClasses: string[] = [];

  for (const cls of inputClasses) {
    if (entry.classes.has(cls)) {
      matchedClasses.push(cls);
    } else {
      unmatchedClasses.push(cls);
    }
  }

  if (matchedClasses.length === 0) {
    return null;
  }

  const score = matchedClasses.length / inputClasses.length;

  const locations = matchedClasses
    .flatMap((cls) => entry.locations.get(cls) ?? [])
    .slice(0, MAX_LOCATIONS_PER_RESULT);

  // Group matched classes by line number to find the maximum matches on any single line
  const lineToMatches = new Map<number, Set<string>>();
  for (const cls of matchedClasses) {
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
    locations,
    maxLineMatches,
  };
}

export function rankFiles(
  inputClasses: string[],
  index: Map<string, FileIndexEntry>,
  options: { minScore?: number; maxResults?: number } = {}
): SearchResult[] {
  const minScore = options.minScore ?? 0;
  const results: SearchResult[] = [];

  for (const entry of index.values()) {
    const result = scoreFile(inputClasses, entry);
    if (result && result.score >= minScore) {
      results.push(result);
    }
  }

  results.sort((a, b) => {
    if (b.maxLineMatches !== a.maxLineMatches) return b.maxLineMatches - a.maxLineMatches;
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    return a.file.localeCompare(b.file);
  });

  return options.maxResults ? results.slice(0, options.maxResults) : results;
}
