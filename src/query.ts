import { parseClassQuery } from "./astExtractor";
import { extractClassesFromPaste, isStyleInput, parsePastedStyleList } from "./classParser";
import type { ReplaceSpec } from "./classReplacer";

export interface ParsedQuery {
  classes: string[];
  isStyle: boolean;
  /** The literal input for raw-text search; absent for style input, which only matches structurally. */
  text?: string;
}

function classesOf(raw: string, isStyle: boolean): string[] {
  return isStyle ? parsePastedStyleList(raw) : parseClassQuery(raw);
}

export function parseQuery(raw: string): ParsedQuery {
  const isStyle = isStyleInput(raw);
  return { classes: classesOf(raw, isStyle), isStyle, text: isStyle ? undefined : raw };
}

export function parseReplace(find: string, replace: string): ReplaceSpec {
  const isStyle = isStyleInput(find);
  return {
    targetClasses: classesOf(find, isStyle),
    replacementClasses: classesOf(replace, isStyle),
    rawTarget: find,
    rawReplacement: replace,
  };
}

export function queryFromPaste(text: string): string {
  const trimmed = text.trim();
  return isStyleInput(trimmed) ? trimmed : extractClassesFromPaste(trimmed);
}

function looksLikeClassInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\bclass(?:Name)?\s*=/i.test(trimmed)) return true;
  if (/[{};()=<>]/.test(trimmed)) return false;
  return /^[a-zA-Z0-9!\-:[\]_./\s]+$/.test(trimmed) && trimmed.split(/\s+/).length >= 2;
}

// The clipboard is read unasked, so only text that plausibly is a class list or style is used.
export function queryFromClipboard(text: string): string | undefined {
  return looksLikeClassInput(text) || isStyleInput(text) ? queryFromPaste(text) : undefined;
}
