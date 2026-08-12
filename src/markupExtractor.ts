import { tokenize } from "./classParser";
import type { ClassLocation, ExtractedClass } from "./types";

const MARKUP_EXTENSIONS = new Set([
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
  ".php",
  ".erb",
  ".twig",
  ".hbs",
  ".handlebars",
]);

export function isMarkupFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return MARKUP_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// Matches `class`, `className`, `class:list`, and the dynamic-binding prefixes used by Vue
// (`:class`, `v-bind:class`) and Alpine (`x-bind:class`). Group layout:
//   1 = dynamic prefix, 2 = name suffix, 3/4 = quoted value, 5 = {braced} value, 6 = `templated`
// Every alternative ends in a single closing delimiter, which is what lets the value offset be
// derived from the match end without searching for the value text again.
const CLASS_ATTR_RE =
  /(?:^|[\s({[<])(v-bind:|x-bind:|:)?class(Name|:list)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|`([^`]*)`)/g;

// Svelte's `class:bg-red-500={cond}` directive — the class name lives in the attribute name.
const SVELTE_CLASS_DIRECTIVE_RE = /(?:^|\s)class:([^\s=/>{]+)/g;

const QUOTED_SEGMENT_RE = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;

// Template interpolations inside an otherwise static attribute: `class="{{ $classes }} p-4"`
// (Blade/Twig/Handlebars) and `class="<?php echo $x; ?> p-4"`. Blanked out rather than treated
// as an expression, so the literal classes sitting beside them survive. Note a quote alone does
// NOT make a value an expression — `class="before:content-['']"` is a real Tailwind class.
const INTERPOLATION_RE = /\{\{[\s\S]*?\}\}|<\?[\s\S]*?\?>|\{%[\s\S]*?%\}|\{[^{}]*\}/g;

/** A run of source text that holds a plain space-separated class list. */
export interface ClassSegment {
  start: number;
  end: number;
  text: string;
}

export interface ClassAttrMatch {
  /** Offset of the `class` keyword itself, used to locate the attribute in the file. */
  attrOffset: number;
  segments: ClassSegment[];
}

// Every quoted string inside an expression value — `{ 'bg-red-500': isError }` yields "bg-red-500".
function expressionSegments(value: string, valueStart: number): ClassSegment[] {
  const re = new RegExp(QUOTED_SEGMENT_RE.source, QUOTED_SEGMENT_RE.flags);
  const segments: ClassSegment[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(value)) !== null) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    const start = valueStart + match.index + 1; // +1 skips the opening quote
    segments.push({ start, end: start + text.length, text });
  }

  return segments;
}

// The runs of a static attribute value that sit outside any template interpolation. Returned as
// spans rather than one blanked-out string so a replacement can never overwrite the interpolation.
function staticSegments(value: string, valueStart: number): ClassSegment[] {
  const re = new RegExp(INTERPOLATION_RE.source, INTERPOLATION_RE.flags);
  const segments: ClassSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const push = (from: number, to: number): void => {
    if (to <= from) return;
    segments.push({
      start: valueStart + from,
      end: valueStart + to,
      text: value.slice(from, to),
    });
  };

  while ((match = re.exec(value)) !== null) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, value.length);

  return segments;
}

export function scanClassAttributes(source: string): ClassAttrMatch[] {
  const matches: ClassAttrMatch[] = [];
  const re = new RegExp(CLASS_ATTR_RE.source, CLASS_ATTR_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const value = match[3] ?? match[4] ?? match[5] ?? match[6] ?? "";
    const attrOffset = match.index + Math.max(0, match[0].indexOf("class"));
    const valueStart = match.index + match[0].length - 1 - value.length;
    // A dynamic binding (`:class`) or a braced value (`class={...}`) is code; anything else is a
    // literal class list that may merely be interrupted by template interpolations.
    const isExpression = match[1] !== undefined || match[5] !== undefined;

    matches.push({
      attrOffset,
      segments: isExpression
        ? expressionSegments(value, valueStart)
        : staticSegments(value, valueStart),
    });
  }

  return matches;
}

/** Svelte `class:foo={cond}` directives, as (offset, class name) pairs. */
export function scanClassDirectives(source: string): ClassSegment[] {
  const re = new RegExp(SVELTE_CLASS_DIRECTIVE_RE.source, SVELTE_CLASS_DIRECTIVE_RE.flags);
  const found: ClassSegment[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    if (match[1] === "list") continue; // Astro's class:list — an attribute, handled above
    const start = match.index + match[0].indexOf("class") + "class:".length;
    found.push({ start, end: start + match[1].length, text: match[1] });
  }

  return found;
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function extractClassesFromMarkup(source: string, filePath: string): ExtractedClass[] {
  const lineStarts = buildLineStarts(source);
  const sourceLines = source.split(/\r?\n/);
  const found: ExtractedClass[] = [];

  const emit = (raw: string, offset: number): void => {
    if (!raw) return;
    const line = lineAt(lineStarts, offset);
    const location: ClassLocation = {
      file: filePath,
      line,
      column: offset - lineStarts[line],
      context: (sourceLines[line] ?? raw).trim().slice(0, 140),
    };
    for (const token of tokenize(raw)) {
      found.push({ className: token, location });
    }
  };

  for (const attr of scanClassAttributes(source)) {
    for (const segment of attr.segments) {
      emit(segment.text, attr.attrOffset);
    }
  }

  for (const directive of scanClassDirectives(source)) {
    emit(directive.text, directive.start);
  }

  return found;
}

export interface EmbeddedScript {
  code: string;
  /** 0-based line in the host file where `code` begins, added back to parsed locations. */
  lineOffset: number;
}

const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const ASTRO_FRONTMATTER_RE = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---/;

export function embeddedScriptBlocks(source: string): EmbeddedScript[] {
  const blocks: EmbeddedScript[] = [];
  const lineStarts = buildLineStarts(source);

  const frontmatter = ASTRO_FRONTMATTER_RE.exec(source);
  if (frontmatter) {
    const codeStart = frontmatter.index + frontmatter[0].indexOf("\n") + 1;
    blocks.push({ code: frontmatter[1], lineOffset: lineAt(lineStarts, codeStart) });
  }

  const re = new RegExp(SCRIPT_BLOCK_RE.source, SCRIPT_BLOCK_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const codeStart = match.index + match[0].indexOf(">") + 1;
    blocks.push({ code: match[1], lineOffset: lineAt(lineStarts, codeStart) });
  }

  return blocks;
}
