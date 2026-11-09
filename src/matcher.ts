import { arbitraryValueBase } from "./classParser";
import { entryText, type SourceText } from "./text";
import type { ClassLocation, FileIndexEntry, NearMatch, SearchResult } from "./types";

const MAX_LOCATIONS_PER_RESULT = 12;
const NEAR_MATCH_WEIGHT = 0.7;

// Splits on delimiters that can't appear inside a class token, so variant colons, arbitrary
// brackets, "!" and "/" stay intact (hover:bg-red-500, w-[30px], !mt-4, border-white/50).
function classTokensOnLine(line: string): Set<string> {
  return new Set(line.split(/[\s"'`{}()<>=,;]+/).filter(Boolean));
}

// The class index caps locations per class (MAX_LOCATIONS_PER_CLASS), so a line with the full
// combo can be undercounted; per-line counts are recomputed from the real source.
function refineLocations(result: SearchResult, inputClasses: string[], text: SourceText): void {
  if (!text.source) {
    return;
  }

  const querySet = new Set(inputClasses);
  const lines = text.lines;

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
    .map((p) => text.locationOfLine(p.line, firstColumn(lines[p.line], querySet)));

  result.locations = mergeByLine(existingTextSearchLocs, classLocs);
  result.maxLineMatches = best;
}

function firstColumn(line: string, needles: Iterable<string>): number {
  let column = 0;
  for (const needle of needles) {
    const idx = line.indexOf(needle);
    if (idx !== -1 && (column === 0 || idx < column)) {
      column = idx;
    }
  }
  return column;
}

function mergeByLine(primary: ClassLocation[], secondary: ClassLocation[]): ClassLocation[] {
  const merged = [...primary];
  for (const loc of secondary) {
    if (!merged.some((l) => l.line === loc.line)) {
      merged.push(loc);
    }
  }
  return merged.slice(0, MAX_LOCATIONS_PER_RESULT);
}

export function queryTerms(query: string): string[] {
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOP_WORDS = new Set(["in", "on", "at", "is", "it", "to", "of", "for", "or", "an", "by", "a", "the", "and", "with"]);

interface TextQuery {
  raw: string;
  lower: string;
  wsRegex?: RegExp;
  firstWordLower: string;
  variants: string[];
  terms: string[];
  stopRegexes: Map<string, RegExp>;
  minRequiredTerms: number;
  windowSize: number;
}

function prepareTextQuery(query: string): TextQuery | null {
  const raw = query.trim();
  if (raw.length < 2) {
    return null;
  }
  const lower = raw.toLowerCase();
  const rawWords = raw.split(/\s+/).filter(Boolean);

  const queryWords = lower.split(/[\s_-]+/).filter(Boolean);
  const variants =
    queryWords.length > 1
      ? [queryWords.join(""), queryWords.join("_"), queryWords.join("-")].filter(
          (v) => v.length >= 2 && v !== lower
        )
      : [];

  const terms = queryTerms(query);
  const significantTerms = terms.filter((t) => !STOP_WORDS.has(t));
  const stopRegexes = new Map<string, RegExp>();
  for (const term of terms) {
    if (STOP_WORDS.has(term)) {
      stopRegexes.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"));
    }
  }

  return {
    raw,
    lower,
    wsRegex: rawWords.length > 1 ? new RegExp(rawWords.map(escapeRegExp).join("\\s+"), "gi") : undefined,
    firstWordLower: (rawWords[0] ?? "").toLowerCase(),
    variants,
    terms,
    stopRegexes,
    minRequiredTerms: significantTerms.length > 0 ? significantTerms.length : terms.length,
    windowSize: Math.min(10, Math.max(5, rawWords.length + 2)),
  };
}

function termMatches(q: TextQuery, term: string, text: string): boolean {
  const stopRe = q.stopRegexes.get(term);
  return stopRe ? stopRe.test(text) : text.includes(term);
}

export function searchTextInFile(
  query: string,
  entry: FileIndexEntry,
  options: { allowTermFallback?: boolean } = {}
): SearchResult | null {
  const q = prepareTextQuery(query);
  return q ? matchText(q, entry, options.allowTermFallback !== false) : null;
}

function phraseOffsets(q: TextQuery, text: SourceText): number[] {
  const offsets: number[] = [];
  const collect = (needle: string) => {
    for (let i = text.lower.indexOf(needle); i !== -1; i = text.lower.indexOf(needle, i + 1)) {
      offsets.push(i);
    }
  };

  collect(q.lower);
  if (q.wsRegex && text.lower.includes(q.firstWordLower)) {
    const re = q.wsRegex;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text.source)) !== null) {
      offsets.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  for (const v of q.variants) {
    collect(v);
  }
  return offsets;
}

function textResult(
  q: TextQuery,
  file: string,
  locations: ClassLocation[],
  matched: number,
  total: number,
  phrase: boolean
): SearchResult {
  const score = phrase ? 1 : matched / total;
  return {
    file,
    matchedCount: matched,
    totalInputCount: total,
    score,
    matchedClasses: [q.raw],
    unmatchedClasses: [],
    nearMatches: [],
    locations: locations.slice(0, MAX_LOCATIONS_PER_RESULT),
    maxLineMatches: phrase ? 1 : matched,
    matchType: "text",
    textScore: score,
    textPhrase: phrase,
  };
}

function matchText(q: TextQuery, entry: FileIndexEntry, allowTermFallback: boolean): SearchResult | null {
  const text = entryText(entry);
  if (!text.source) {
    return null;
  }

  const offsets = phraseOffsets(q, text);
  if (offsets.length > 0) {
    const seen = new Set<string>();
    const locations: ClassLocation[] = [];
    for (const offset of offsets) {
      const loc = text.locationAt(offset);
      const key = `${loc.line}:${loc.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(loc);
    }
    return textResult(q, entry.file, locations, locations.length, 1, true);
  }

  const { terms, minRequiredTerms } = q;
  if (!allowTermFallback || terms.length === 0) {
    return null;
  }

  let present = 0;
  for (const term of terms) {
    if (termMatches(q, term, text.lower)) present++;
  }
  if (present < minRequiredTerms) {
    return null;
  }

  const lowerLines = text.lowerLines;
  const countTerms = (s: string) => terms.reduce((n, term) => n + (termMatches(q, term, s) ? 1 : 0), 0);

  let bestTermCount = 0;
  const perLine: { line: number; count: number }[] = [];
  const consider = (line: number, count: number) => {
    if (count >= minRequiredTerms) {
      perLine.push({ line, count });
      if (count > bestTermCount) bestTermCount = count;
    }
  };

  for (let i = 0; i < lowerLines.length; i++) {
    consider(i, countTerms(lowerLines[i]));
  }
  if (bestTermCount === 0) {
    for (let i = 0; i < lowerLines.length; i++) {
      consider(i, countTerms(lowerLines.slice(i, i + q.windowSize).join(" ")));
    }
  }
  if (bestTermCount === 0) {
    return null;
  }

  const locations = perLine
    .filter((p) => p.count === bestTermCount)
    .slice(0, MAX_LOCATIONS_PER_RESULT)
    .map((p) => text.locationOfLine(p.line, firstColumn(lowerLines[p.line] ?? "", terms)));

  return textResult(q, entry.file, locations, bestTermCount, terms.length, false);
}

export function scoreFile(inputClasses: string[], entry: FileIndexEntry): SearchResult | null {
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

  const matchedAndNear = [...matchedClasses, ...nearMatches.map((nm) => nm.actual)];

  const lineToMatches = new Map<number, Set<string>>();
  const lineToLocation = new Map<number, ClassLocation>();
  for (const cls of matchedAndNear) {
    for (const loc of entry.locations.get(cls) ?? []) {
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

  // Sub-locations are "other places this same combination shows up" (e.g. a repeated component),
  // not every element sharing one matched class, so only lines tied for the best overlap count.
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

  const matchedTokens = new Set<string>();
  for (const entry of index.values()) {
    const result = scoreFile(inputClasses, entry);
    if (result) {
      for (const cls of result.matchedClasses) matchedTokens.add(cls);
      for (const nm of result.nearMatches) matchedTokens.add(nm.input);
      if (result.score >= minScore) {
        refineLocations(result, inputClasses, entryText(entry));
        resultsMap.set(entry.file, result);
      }
    }
  }

  const classRate = inputClasses.length > 0 ? matchedTokens.size / inputClasses.length : 0;
  const proseQuery = classRate < CLASS_QUERY_THRESHOLD;

  const textQuery = options.rawInput ? prepareTextQuery(options.rawInput) : null;
  if (textQuery) {
    for (const entry of index.values()) {
      const textResult = matchText(textQuery, entry, proseQuery);
      if (!textResult) continue;

      const existing = resultsMap.get(entry.file);
      if (existing) {
        // The literal query is the stronger locator, so text-hit lines go first.
        existing.locations = mergeByLine(textResult.locations, existing.locations);
        existing.matchType = "both";
        existing.textScore = textResult.textScore;
        // A scattered-term hit shouldn't inflate a partial class match; only a full phrase does.
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

  results.sort((a, b) => {
    if (proseQuery) {
      const at = hasTextSignal(a) ? 0 : 1;
      const bt = hasTextSignal(b) ? 0 : 1;
      if (at !== bt) return at - bt;
      if (at === 0) {
        const ax = a.textScore ?? 0;
        const bx = b.textScore ?? 0;
        if (bx !== ax) return bx - ax;
      }
      return classComparator(a, b);
    }
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
    return head;
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
