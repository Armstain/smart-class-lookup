import type { FileIndexEntry } from "./types";
import { computeReplacements, type TextEdit } from "./classReplacer";

export interface ReplaceOccurrence {
  key: string;
  file: string;
  line: number;
  before: string;
  after: string;
}

export interface AppliedEdit {
  file: string;
  start: number;
  end: number;
  newText: string;
}

export interface ApplySelectedResult {
  applied: AppliedEdit[];
  skippedCount: number;
}

// Files that could plausibly contain a target class or raw search target, per the workspace index.
export function filterCandidateFiles(
  index: Map<string, FileIndexEntry>,
  targetClasses: string[],
  rawTarget?: string
): string[] {
  const targetSet = new Set(targetClasses.map((t) => t.toLowerCase()));
  const rawLower = rawTarget?.trim().toLowerCase();
  const files: string[] = [];

  for (const entry of index.values()) {
    const hasClassMatch = Array.from(entry.classes).some((c) => targetSet.has(c.toLowerCase()));
    if (hasClassMatch) {
      files.push(entry.file);
      continue;
    }

    const source = entry.source;
    if (source) {
      const sourceLower = source.toLowerCase();
      if (rawLower && sourceLower.includes(rawLower)) {
        files.push(entry.file);
        continue;
      }
      if (targetClasses.some((tc) => sourceLower.includes(tc.toLowerCase()))) {
        files.push(entry.file);
      }
    }
  }
  return files;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/).length - 1;
}

interface RawOccurrence {
  file: string;
  edit: TextEdit;
  line: number;
  before: string;
  after: string;
  key: string;
}

// Shared by the preview list and the apply step. The key is (file, line, original text) rather
// than the raw offset so it survives unrelated edits elsewhere in the file; a per-group counter
// disambiguates duplicate occurrences on the same line.
function computeOccurrences(
  sources: Map<string, string>,
  targetClasses: string[],
  replacementClasses: string[],
  rawTarget?: string,
  rawReplacement?: string
): RawOccurrence[] {
  const result: RawOccurrence[] = [];
  const dupCounts = new Map<string, number>();

  for (const [file, source] of sources) {
    const edits = computeReplacements(source, targetClasses, replacementClasses, rawTarget, rawReplacement, file);
    // computeReplacements sorts descending by start; read ascending so occurrence order reads top-to-bottom.
    const ordered = [...edits].sort((a, b) => a.start - b.start);
    for (const edit of ordered) {
      const line = lineOf(source, edit.start);
      const before = source.slice(edit.start, edit.end).trim();
      const after = edit.newText.trim();
      const baseKey = `${file} ${line} ${before}`;
      const dupIndex = dupCounts.get(baseKey) ?? 0;
      dupCounts.set(baseKey, dupIndex + 1);
      const key = dupIndex === 0 ? baseKey : `${baseKey} ${dupIndex}`;
      result.push({ file, edit, line, before, after, key });
    }
  }

  return result;
}

// Every occurrence a replace would touch, with a stable key for the webview's selection state.
export function collectReplacements(
  sources: Map<string, string>,
  targetClasses: string[],
  replacementClasses: string[],
  rawTarget?: string,
  rawReplacement?: string
): ReplaceOccurrence[] {
  return computeOccurrences(sources, targetClasses, replacementClasses, rawTarget, rawReplacement).map((o) => ({
    key: o.key,
    file: o.file,
    line: o.line,
    before: o.before,
    after: o.after,
  }));
}

// Re-derives occurrences from the current source and applies only the still-selected ones. A
// file changed since preview means its stale key won't reappear — it's dropped and counted as
// skipped rather than applied at a stale offset.
export function applySelectedEdits(
  sources: Map<string, string>,
  targetClasses: string[],
  replacementClasses: string[],
  selectedKeys: Set<string>,
  rawTarget?: string,
  rawReplacement?: string
): ApplySelectedResult {
  const occurrences = computeOccurrences(sources, targetClasses, replacementClasses, rawTarget, rawReplacement);
  const applied: AppliedEdit[] = [];

  for (const o of occurrences) {
    if (selectedKeys.has(o.key)) {
      applied.push({ file: o.file, start: o.edit.start, end: o.edit.end, newText: o.edit.newText });
    }
  }

  const skippedCount = Math.max(0, selectedKeys.size - applied.length);
  return { applied, skippedCount };
}

