import { computeReplacements, type ReplaceSpec, type TextEdit } from "./classReplacer";
import { buildLineStarts, lineAt, entryText } from "./text";
import type { FileIndexEntry } from "./types";

export interface ReplaceOccurrence {
  key: string;
  file: string;
  line: number;
  before: string;
  after: string;
}

export interface AppliedEdit extends TextEdit {
  file: string;
}

export interface ApplySelectedResult {
  applied: AppliedEdit[];
  skippedCount: number;
}

export function filterCandidateFiles(index: Map<string, FileIndexEntry>, spec: ReplaceSpec): string[] {
  const targets = spec.targetClasses.map((t) => t.toLowerCase());
  const targetSet = new Set(targets);
  const rawLower = spec.rawTarget?.trim().toLowerCase();
  const files: string[] = [];

  for (const entry of index.values()) {
    if (Array.from(entry.classes).some((c) => targetSet.has(c.toLowerCase()))) {
      files.push(entry.file);
      continue;
    }
    const lower = entryText(entry).lower;
    if ((rawLower && lower.includes(rawLower)) || targets.some((tc) => lower.includes(tc))) {
      files.push(entry.file);
    }
  }
  return files;
}

interface Occurrence extends ReplaceOccurrence {
  edit: TextEdit;
}

// The key is (file, line, original text) rather than the raw offset so it survives unrelated
// edits elsewhere in the file; a per-group counter disambiguates duplicates on the same line.
function computeOccurrences(sources: Map<string, string>, spec: ReplaceSpec): Occurrence[] {
  const result: Occurrence[] = [];
  const dupCounts = new Map<string, number>();

  for (const [file, source] of sources) {
    const lineStarts = buildLineStarts(source);
    const ascending = computeReplacements(source, file, spec).sort((a, b) => a.start - b.start);
    for (const edit of ascending) {
      const line = lineAt(lineStarts, edit.start);
      const before = source.slice(edit.start, edit.end).trim();
      const after = edit.newText.trim();
      const baseKey = `${file} ${line} ${before}`;
      const dupIndex = dupCounts.get(baseKey) ?? 0;
      dupCounts.set(baseKey, dupIndex + 1);
      const key = dupIndex === 0 ? baseKey : `${baseKey} ${dupIndex}`;
      result.push({ key, file, line, before, after, edit });
    }
  }

  return result;
}

export function collectReplacements(sources: Map<string, string>, spec: ReplaceSpec): ReplaceOccurrence[] {
  return computeOccurrences(sources, spec).map(({ edit, ...occurrence }) => occurrence);
}

// Re-derives occurrences from the current source, so an occurrence whose file changed since the
// preview no longer reproduces its key and is skipped rather than applied at a stale offset.
export function applySelectedEdits(
  sources: Map<string, string>,
  spec: ReplaceSpec,
  selectedKeys: Set<string>
): ApplySelectedResult {
  const applied = computeOccurrences(sources, spec)
    .filter((o) => selectedKeys.has(o.key))
    .map((o) => ({ file: o.file, ...o.edit }));
  return { applied, skippedCount: Math.max(0, selectedKeys.size - applied.length) };
}
