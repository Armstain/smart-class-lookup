/**
 * Shared types for Smart Class Lookup.
 */

/** A single location where a class token was found inside a source file. */
export interface ClassLocation {
  /** Absolute file path. */
  file: string;
  /** 0-based line number (matches vscode.Position). */
  line: number;
  /** 0-based column number (matches vscode.Position). */
  column: number;
  /**
   * The full literal/template text the class token came from, trimmed.
   * Used to render a small "context" preview in the results UI.
   */
  context: string;
}

/** Everything we know about a single indexed file. */
export interface FileIndexEntry {
  /** Absolute file path. */
  file: string;
  /** All distinct Tailwind classes found in this file. */
  classes: Set<string>;
  /** class -> every place it was found in this file. */
  locations: Map<string, ClassLocation[]>;
  /** mtimeMs at the time this entry was built, used to detect stale entries. */
  mtimeMs: number;
}

/** A scored search result for a single file. */
export interface SearchResult {
  file: string;
  /** Number of input classes that were found in this file. */
  matchedCount: number;
  /** Total number of classes the user pasted in. */
  totalInputCount: number;
  /** matchedCount / totalInputCount, in the range [0, 1]. */
  score: number;
  /** The actual classes that matched, in the order the user pasted them. */
  matchedClasses: string[];
  /** Classes the user pasted that were NOT found in this file. */
  unmatchedClasses: string[];
  /** Best representative locations for the matched classes (deduped, capped). */
  locations: ClassLocation[];
}
