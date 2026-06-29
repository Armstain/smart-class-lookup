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
}

export interface SearchResult {
  file: string;
  matchedCount: number;
  totalInputCount: number;
  score: number;
  matchedClasses: string[];
  unmatchedClasses: string[];
  locations: ClassLocation[];
  maxLineMatches: number;
}
