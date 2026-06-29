/**
 * Scoring logic: given the set of classes the user pasted and the set of
 * classes found in a given file, compute a similarity score.
 *
 * Order never matters -- both sides are treated as sets. The score is
 * defined as (matched classes) / (total pasted classes), which matches the
 * spec exactly: pasting 9 classes and finding 8 of them in a file scores
 * 8/9 ≈ 88%, regardless of what order either side lists its classes in.
 */

import type { FileIndexEntry, SearchResult } from "./types";

const MAX_LOCATIONS_PER_RESULT = 12;

/**
 * Score a single file against the pasted (and already deduplicated) input
 * class list. Returns `null` if there is no overlap at all, so callers can
 * cheaply filter out files with zero relevance.
 */
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

/**
 * Score every file in the index against the pasted class list and return
 * results sorted highest-score-first. Ties are broken by raw matched count,
 * then alphabetically by file path for stable, predictable ordering.
 */
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
