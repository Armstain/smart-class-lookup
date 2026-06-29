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

  return {
    file: entry.file,
    matchedCount: matchedClasses.length,
    totalInputCount: inputClasses.length,
    score,
    matchedClasses,
    unmatchedClasses,
    locations,
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
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
    return a.file.localeCompare(b.file);
  });

  return options.maxResults ? results.slice(0, options.maxResults) : results;
}
