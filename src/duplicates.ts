import type { FileIndexEntry } from "./types";

export interface DuplicateOccurrence {
  file: string;
  line: number;
  context: string;
}

export interface DuplicateGroup {
  classes: string[];
  occurrences: DuplicateOccurrence[];
}

/**
 * Finds groups of files that render an element with the exact same set of
 * classes (same line-level combination), which usually means the markup
 * should be extracted into a shared component.
 */
export function findDuplicateClassGroups(
  index: Map<string, FileIndexEntry>,
  minClasses = 3
): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();

  for (const entry of index.values()) {
    const lineClasses = new Map<number, { classes: Set<string>; context: string }>();

    for (const [cls, locs] of entry.locations) {
      for (const loc of locs) {
        let rec = lineClasses.get(loc.line);
        if (!rec) {
          rec = { classes: new Set(), context: loc.context };
          lineClasses.set(loc.line, rec);
        }
        rec.classes.add(cls);
      }
    }

    for (const [line, rec] of lineClasses) {
      if (rec.classes.size < minClasses) continue;

      const sortedClasses = [...rec.classes].sort();
      const signature = sortedClasses.join(" ");

      let group = groups.get(signature);
      if (!group) {
        group = { classes: sortedClasses, occurrences: [] };
        groups.set(signature, group);
      }
      group.occurrences.push({ file: entry.file, line, context: rec.context });
    }
  }

  return Array.from(groups.values())
    .filter((g) => new Set(g.occurrences.map((o) => o.file)).size >= 2)
    .sort((a, b) => b.occurrences.length - a.occurrences.length || b.classes.length - a.classes.length);
}
