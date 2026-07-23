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

// Splits on delimiters that can't appear inside a class token, so variant colons, arbitrary
// brackets, "!" and "/" stay intact (hover:bg-red-500, w-[30px], !mt-4, border-white/50).
function classTokensOnLine(line: string): Set<string> {
  return new Set(line.split(/[\s"'`{}()<>=,;]+/).filter(Boolean));
}

// Recomputes accurate per-line match counts from the real source — the class index caps
// locations per class, so a line with the full combo can otherwise be undercounted.
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

// Splits a query into lower-cased terms, keeping class-like tokens (w-[10px], hover:bg-red-500)
// whole and trimming prose punctuation ("TODO:" -> "todo").
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[\s,;]+/)) {
    const term = raw.replace(/^[.,;:!?"'`]+/, "").replace(/[.,;:!?"'`]+$/, "");
    if (term.length >= 2 && !seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

// Searches all raw source text (comments, JSX text, prop names, strings), not just class names.
// A full contiguous phrase match is the strongest signal; failing that, terms co-occurring on
// a line are ranked by coverage.
export function searchTextInFile(
  query: string,
  entry: FileIndexEntry,
  options: { allowTermFallback?: boolean } = {}
): SearchResult | null {
  const source = getOrLoadSource(entry);
  if (!source) {
    return null;
  }

  const lines = source.split(/\r?\n/);
  const queryLower = query.trim().toLowerCase();

  // 1. Phrase match — the query as one contiguous substring.
  if (queryLower.length >= 2) {
    const phraseLocs: ClassLocation[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const lineLower = lineText.toLowerCase();
      let index = lineLower.indexOf(queryLower);
      while (index !== -1) {
        phraseLocs.push({
          file: entry.file,
          line: i,
          column: index,
          context: lineText.trim().slice(0, 140),
        });
        index = lineLower.indexOf(queryLower, index + 1);
      }
    }
    if (phraseLocs.length > 0) {
      return {
        file: entry.file,
        matchedCount: phraseLocs.length,
        totalInputCount: 1,
        score: 1.0,
        matchedClasses: [query],
        unmatchedClasses: [],
        nearMatches: [],
        locations: phraseLocs.slice(0, MAX_LOCATIONS_PER_RESULT),
        maxLineMatches: 1,
        matchType: "text",
        textScore: 1.0,
        textPhrase: true,
      };
    }
  }

  // 2. Term-coverage fallback. Only worth it for prose queries — for a class-list query,
  // "some of these words appear somewhere" is coincidence, not signal.
  if (options.allowTermFallback === false) {
    return null;
  }

  const terms = queryTerms(query);
  if (terms.length === 0) {
    return null;
  }

  let bestTermCount = 0;
  const perLine: { line: number; count: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let count = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) {
        count++;
      }
    }
    if (count > 0) {
      perLine.push({ line: i, count });
      if (count > bestTermCount) {
        bestTermCount = count;
      }
    }
  }

  if (bestTermCount === 0) {
    return null;
  }

  const locations = perLine
    .filter((p) => p.count === bestTermCount)
    .slice(0, MAX_LOCATIONS_PER_RESULT)
    .map((p) => {
      const lineText = lines[p.line];
      const lineLower = lineText.toLowerCase();
      let column = 0;
      for (const term of terms) {
        const idx = lineLower.indexOf(term);
        if (idx !== -1 && (column === 0 || idx < column)) {
          column = idx;
        }
      }
      return {
        file: entry.file,
        line: p.line,
        column,
        context: lineText.trim().slice(0, 140),
      };
    });

  const coverage = bestTermCount / terms.length;
  return {
    file: entry.file,
    matchedCount: bestTermCount,
    totalInputCount: terms.length,
    score: coverage,
    matchedClasses: [query],
    unmatchedClasses: [],
    nearMatches: [],
    locations,
    maxLineMatches: bestTermCount,
    matchType: "text",
    textScore: coverage,
    textPhrase: false,
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
    matchType: "class",
  };
}

// Share of query tokens that must be real classes before class matches lead the ranking.
const CLASS_QUERY_THRESHOLD = 0.6;
// Text-only hits reserved a slot so a class-heavy result list can't truncate them entirely.
const RESERVED_TEXT_SLOTS = 3;

function classComparator(a: SearchResult, b: SearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.maxLineMatches !== a.maxLineMatches) return b.maxLineMatches - a.maxLineMatches;
  if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
  return a.file.localeCompare(b.file);
}

function hasTextSignal(r: SearchResult): boolean {
  return r.matchType === "text" || r.matchType === "both";
}

export function rankFiles(
  inputClasses: string[],
  index: Map<string, FileIndexEntry>,
  options: { minScore?: number; maxResults?: number; rawInput?: string } = {}
): SearchResult[] {
  const minScore = options.minScore ?? 0;
  const resultsMap = new Map<string, SearchResult>();

  // 1. Class-based lookup, tracking which query tokens matched a real class anywhere.
  const matchedTokens = new Set<string>();
  for (const entry of index.values()) {
    const result = scoreFile(inputClasses, entry);
    if (result) {
      for (const cls of result.matchedClasses) matchedTokens.add(cls);
      for (const nm of result.nearMatches) matchedTokens.add(nm.input);
      if (result.score >= minScore) {
        refineLocations(result, inputClasses, entry);
        resultsMap.set(entry.file, result);
      }
    }
  }

  const classRate = inputClasses.length > 0 ? matchedTokens.size / inputClasses.length : 0;
  const proseQuery = classRate < CLASS_QUERY_THRESHOLD;

  // 2. Text search — always run when there's a usable raw query, across all source text.
  const rawInput = options.rawInput?.trim();
  if (rawInput && rawInput.length >= 2) {
    for (const entry of index.values()) {
      const textResult = searchTextInFile(rawInput, entry, { allowTermFallback: proseQuery });
      if (!textResult) continue;

      const existing = resultsMap.get(entry.file);
      if (existing) {
        // Both signals matched — text-hit lines first, the literal query is the stronger locator.
        const mergedLocations = [...textResult.locations];
        for (const loc of existing.locations) {
          if (!mergedLocations.some((l) => l.line === loc.line)) {
            mergedLocations.push(loc);
          }
        }
        existing.locations = mergedLocations.slice(0, MAX_LOCATIONS_PER_RESULT);
        existing.matchType = "both";
        existing.textScore = textResult.textScore;
        existing.textPhrase = textResult.textPhrase;
        // Only a full-phrase hit is strong enough to force a perfect score; a scattered-term
        // hit shouldn't inflate a partial class match.
        if (textResult.textPhrase) {
          existing.score = 1.0;
          existing.maxLineMatches = Math.max(existing.maxLineMatches, inputClasses.length || 1);
        }
      } else {
        resultsMap.set(entry.file, textResult);
      }
    }
  }

  const results = Array.from(resultsMap.values());

  // 3. Adaptive ranking: prose queries rank text first, class queries rank class first.
  results.sort((a, b) => {
    if (proseQuery) {
      const at = hasTextSignal(a) ? 0 : 1;
      const bt = hasTextSignal(b) ? 0 : 1;
      if (at !== bt) return at - bt;
      if (at === 0) {
        const ax = a.textScore ?? 0;
        const bx = b.textScore ?? 0;
        if (bx !== ax) return bx - ax;
        return classComparator(a, b);
      }
      return classComparator(a, b);
    }
    // Class query: class + both lead, text-only trails.
    const at = a.matchType === "text" ? 1 : 0;
    const bt = b.matchType === "text" ? 1 : 0;
    if (at !== bt) return at - bt;
    if (at === 1) {
      const ax = a.textScore ?? 0;
      const bx = b.textScore ?? 0;
      if (bx !== ax) return bx - ax;
      return a.file.localeCompare(b.file);
    }
    return classComparator(a, b);
  });

  return applyLimit(results, options.maxResults, proseQuery);
}

// Slices to maxResults, reserving a few text-only hits so they aren't truncated off the bottom.
function applyLimit(
  results: SearchResult[],
  maxResults: number | undefined,
  proseQuery: boolean
): SearchResult[] {
  if (!maxResults || results.length <= maxResults) {
    return results;
  }
  const head = results.slice(0, maxResults);
  if (proseQuery) {
    return head; // prose mode already ranks text first — nothing to rescue
  }
  const textInHead = head.filter((r) => r.matchType === "text").length;
  const need = RESERVED_TEXT_SLOTS - textInHead;
  if (need <= 0) {
    return head;
  }
  const reserved = results
    .slice(maxResults)
    .filter((r) => r.matchType === "text")
    .slice(0, need);
  if (reserved.length === 0) {
    return head;
  }
  return [...head.slice(0, maxResults - reserved.length), ...reserved];
}
