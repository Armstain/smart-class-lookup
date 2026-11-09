import * as fs from "fs";
import type { ClassLocation, FileIndexEntry } from "./types";

const CONTEXT_LENGTH = 140;

export function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

export function location(file: string, lines: string[], line: number, column: number): ClassLocation {
  return { file, line, column, context: (lines[line] ?? "").trim().slice(0, CONTEXT_LENGTH) };
}

export class SourceText {
  private _lower?: string;
  private _lines?: string[];
  private _lowerLines?: string[];
  private _lineStarts?: number[];

  constructor(readonly file: string, readonly source: string) {}

  get lower(): string {
    return (this._lower ??= this.source.toLowerCase());
  }

  get lines(): string[] {
    return (this._lines ??= splitLines(this.source));
  }

  get lowerLines(): string[] {
    return (this._lowerLines ??= splitLines(this.lower));
  }

  get lineStarts(): number[] {
    return (this._lineStarts ??= buildLineStarts(this.source));
  }

  locationAt(offset: number): ClassLocation {
    const line = lineAt(this.lineStarts, offset);
    return location(this.file, this.lines, line, offset - this.lineStarts[line]);
  }

  locationOfLine(line: number, column: number): ClassLocation {
    return location(this.file, this.lines, line, column);
  }
}

export function entryText(entry: FileIndexEntry): SourceText {
  if (!entry.text) {
    let source = "";
    try {
      source = fs.readFileSync(entry.file, "utf8");
    } catch {
      source = "";
    }
    entry.text = new SourceText(entry.file, source);
  }
  return entry.text;
}
