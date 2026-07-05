import * as fs from "fs";
import { arbitraryValueBase } from "./classParser";
import type { ClassLocation, FileIndexEntry, NearMatch, SearchResult } from "./types";

const MAX_LOCATIONS_PER_RESULT = 12;
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

// Split a source line into class-name-like tokens. The delimiters are the characters that
// can't appear inside a class token (whitespace, quotes, the braces/parens/angle brackets
// JSX uses, commas, etc.). Variant colons, arbitrary-value brackets, "!" important flags and
// "/" opacity stay intact, so tokens like hover:bg-red-500, w-[30px], !mt-4 and border-white/50
// compare cleanly against the query. Non-class identifiers (className, div, const) are harmless
// since we only ever intersect against the known query set.
function classTokensOnLine(line: string): Set<string> {
  return new Set(line.split(/[\s"'`{}()<>=,;]+/).filter(Boolean));
}

// Recompute a result's displayed locations by scanning the real source, counting how many
// query classes actually co-occur on each line, and keeping only the lines tied at the true
// maximum. The class-based index caps locations at 8 per class (see indexer), so a deep line
// holding the full combo can be undercounted and lose to shallower lines that share only a few
// common classes. Reading the source here — done only for the handful of displayed results —
// gives an accurate count and drops those "technically matched, practically irrelevant" lines.
function refineLocations(
  result: SearchResult,
  inputClasses: string[],
  entry: FileIndexEntry | undefined
): void {
  if (!entry) {
    return;
  }
  const source = getOrLoadSource(entry);
  if (!source) {
    return;
  }

  const querySet = new Set(inputClasses);
  const lines = source.split(/\r?\n/);

  let best = 0;
  const perLine: { line: number; count: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const tokens = classTokensOnLine(lines[i]);
    let count = 0;
    for (const cls of querySet) {
      if (tokens.has(cls)) {
        count++;
      }
    }
    if (count > 0) {
      perLine.push({ line: i, count });
      if (count > best) {
        best = count;
      }
    }
  }

  // No whole-token overlap (e.g. a file matched only via arbitrary-value near-matches, whose
  // bracket contents differ) — leave the index-derived locations untouched.
  if (best === 0) {
    return;
  }

  const existingTextSearchLocs = result.locations.filter((loc) => {
    const tokens = classTokensOnLine(lines[loc.line]);
    return !inputClasses.some((cls) => tokens.has(cls));
  });

  const classLocs = perLine
    .filter((p) => p.count === best)
    .slice(0, MAX_LOCATIONS_PER_RESULT)
    .map((p) => {
      const lineText = lines[p.line];
      let column = 0;
      for (const cls of querySet) {
        const idx = lineText.indexOf(cls);
        if (idx !== -1 && (column === 0 || idx < column)) {
          column = idx;
        }
      }
      return {
        file: result.file,
        line: p.line,
        column,
        context: lineText.trim().slice(0, 140),
      };
    });

  const merged = [...existingTextSearchLocs];
  for (const loc of classLocs) {
    if (!merged.some((l) => l.line === loc.line)) {
      merged.push(loc);
    }
  }
  result.locations = merged.slice(0, MAX_LOCATIONS_PER_RESULT);
  result.maxLineMatches = best;
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
  const matchedAndNear = [...matchedClasses, ...nearMatchActualNames];

  // Group matched (+ near-matched) classes by line number to find the maximum matches on any single line
  const lineToMatches = new Map<number, Set<string>>();
  const lineToLocation = new Map<number, ClassLocation>();
  for (const cls of matchedAndNear) {
    const locs = entry.locations.get(cls) ?? [];
    for (const loc of locs) {
      let set = lineToMatches.get(loc.line);
      if (!set) {
        set = new Set();
        lineToMatches.set(loc.line, set);
      }
      set.add(cls);
      if (!lineToLocation.has(loc.line)) {
        lineToLocation.set(loc.line, loc);
      }
    }
  }

  let maxLineMatches = 0;
  for (const matchSet of lineToMatches.values()) {
    if (matchSet.size > maxLineMatches) {
      maxLineMatches = matchSet.size;
    }
  }

  // Only surface lines tied for the best overlap with the query. The point of the
  // sub-location list is "other places this same combination shows up" (e.g. a repeated
  // component), not "every element that happens to share one matched class" — a line with
  // just 1 of 7 matched classes isn't a useful candidate once a fuller match exists.
  const locations = Array.from(lineToLocation.entries())
    .filter(([line]) => lineToMatches.get(line)?.size === maxLineMatches)
    .sort(([lineA], [lineB]) => lineA - lineB)
    .map(([, loc]) => loc)
    .slice(0, MAX_LOCATIONS_PER_RESULT);

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
          // The raw text match found the literal, full multi-class string, so it's the
          // strongest possible signal — put those locations first, ahead of individual
          // per-class hits, instead of only appending them when their line is missing.
          const mergedLocations = [...textResult.locations];
          for (const loc of existing.locations) {
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

  const sliced = options.maxResults ? results.slice(0, options.maxResults) : results;

  // Re-derive displayed locations from the real source, but only for the results we return —
  // this is where the accurate per-line counts matter and the source-read cost is bounded.
  for (const result of sliced) {
    refineLocations(result, inputClasses, index.get(result.file));
  }

  return sliced;
}
