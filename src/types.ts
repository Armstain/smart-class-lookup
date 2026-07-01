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
}
