export interface ClassLocation {
  file: string;
  line: number;
  column: number;
  context: string;
}

export interface FileIndexEntry {
  file: string;
  classes: Set<string>;
  locations: Map<string, ClassLocation[]>;
  mtimeMs: number;
  source?: string;
  /** Maps an arbitrary-value class with its bracket contents blanked out (e.g. "w-[]") to the actual classes in this file that share that base. */
  arbitraryIndex?: Map<string, string[]>;
}

export interface NearMatch {
  input: string;
  actual: string;
}

// "class": matched indexed classes. "text": matched raw source text only. "both": matched classes
// and the raw query also appears literally in the source.
export type MatchType = "class" | "text" | "both";

export interface SearchResult {
  file: string;
  matchedCount: number;
  totalInputCount: number;
  score: number;
  matchedClasses: string[];
  unmatchedClasses: string[];
  nearMatches: NearMatch[];
  locations: ClassLocation[];
  maxLineMatches: number;
  matchType?: MatchType; // defaults to "class" when absent (e.g. synthetic results)
  textScore?: number; // 0-1: 1 for a full-phrase hit, term-coverage otherwise
  textPhrase?: boolean; // true when the query matched as one contiguous substring
}
