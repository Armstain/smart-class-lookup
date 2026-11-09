import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { parseJs } from "./babel";
import { isMarkupFile } from "./languages";
import { scanClassAttributes, scanClassDirectives } from "./markupExtractor";

export interface ReplaceSpec {
  targetClasses: string[];
  replacementClasses: string[];
  rawTarget?: string;
  rawReplacement?: string;
}

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

class Replacer {
  private readonly targets: Set<string>;
  readonly replacement: string;

  constructor(readonly spec: ReplaceSpec) {
    this.targets = new Set(spec.targetClasses.map((c) => c.toLowerCase()));
    this.replacement = spec.replacementClasses.join(" ");
  }

  isTarget(cls: string): boolean {
    return this.targets.has(cls.toLowerCase());
  }

  replaceInString(value: string): string | null {
    if (!value.trim()) {
      return null;
    }

    let replaced = false;
    const parts = value.split(/(\s+)/).map((part) => {
      const token = part.trim();
      if (!token || !this.isTarget(token)) return part;
      if (replaced) return "";
      replaced = true;
      return this.replacement;
    });

    if (replaced) {
      let newValue = parts.join("").replace(/\s+/g, " ").trim();
      if (/^\s/.test(value) && newValue) newValue = " " + newValue;
      if (/\s$/.test(value) && newValue) newValue = newValue + " ";
      return newValue;
    }

    const { rawTarget, rawReplacement } = this.spec;
    if (rawTarget && rawTarget.trim() && value.includes(rawTarget)) {
      return value.split(rawTarget).join(rawReplacement ?? "");
    }

    return null;
  }
}

// Babel only reaches markup files through JSX error recovery, which silently skips whatever it
// fails to parse and would leave a partial replace behind, so class attributes are edited from
// the same scanner the markup indexer uses.
// ponytail: class attributes only — a class inside a .vue/.svelte <script> cn() call is left to
// the raw-text fallback below. Parse the embedded script blocks here if that becomes a real ask.
function markupEdits(source: string, r: Replacer): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const attr of scanClassAttributes(source)) {
    for (const segment of attr.segments) {
      const newValue = r.replaceInString(segment.text);
      if (newValue !== null) {
        edits.push({ start: segment.start, end: segment.end, newText: newValue });
      }
    }
  }

  for (const directive of scanClassDirectives(source)) {
    if (r.isTarget(directive.text)) {
      edits.push({ start: directive.start, end: directive.end, newText: r.replacement });
    }
  }

  return edits;
}

function scriptEdits(source: string, r: Replacer): TextEdit[] {
  let ast: t.File;
  try {
    ast = parseJs(source, true);
  } catch {
    return [];
  }

  const edits: TextEdit[] = [];
  const editedStarts = new Set<number>();

  const handleString = (value: string, start: number | null | undefined, end: number | null | undefined, quoted: boolean) => {
    if (typeof start !== "number" || typeof end !== "number" || editedStarts.has(start)) return;
    const newValue = r.replaceInString(value);
    if (newValue === null) return;
    editedStarts.add(start);
    if (quoted) {
      const rawText = source.slice(start, end);
      edits.push({ start, end, newText: (rawText[0] ?? '"') + newValue + (rawText[rawText.length - 1] ?? '"') });
    } else {
      edits.push({ start, end, newText: newValue });
    }
  };

  traverse(ast, {
    noScope: true,
    StringLiteral(path: NodePath<t.StringLiteral>) {
      handleString(path.node.value, path.node.start, path.node.end, true);
    },
    TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
      for (const quasi of path.node.quasis) {
        handleString(quasi.value.raw, quasi.start, quasi.end, false);
      }
    },
    JSXText(path: NodePath<t.JSXText>) {
      handleString(path.node.value, path.node.start, path.node.end, false);
    },
    ObjectProperty(path: NodePath<t.ObjectProperty>) {
      if (path.node.computed) return;
      const key = path.node.key;
      if (key.type === "StringLiteral") {
        handleString(key.value, key.start, key.end, true);
      } else if (
        key.type === "Identifier" &&
        typeof key.start === "number" &&
        typeof key.end === "number" &&
        r.isTarget(key.name) &&
        !editedStarts.has(key.start)
      ) {
        editedStarts.add(key.start);
        edits.push({ start: key.start, end: key.end, newText: r.replacement });
      }
    },
  });

  return edits;
}

// Word-boundary checked so e.g. target "card" doesn't match inside "cardTitle".
function rawTextEdits(source: string, r: Replacer): TextEdit[] {
  const { rawTarget, rawReplacement, targetClasses } = r.spec;
  const findTerm = rawTarget?.trim() || targetClasses[0];
  if (!findTerm || !source.includes(findTerm)) return [];

  const replaceTerm = rawReplacement ?? r.replacement;
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  const edits: TextEdit[] = [];
  let pos = source.indexOf(findTerm);
  while (pos !== -1) {
    if (!isWordChar(source[pos - 1]) && !isWordChar(source[pos + findTerm.length])) {
      edits.push({ start: pos, end: pos + findTerm.length, newText: replaceTerm });
      pos = source.indexOf(findTerm, pos + findTerm.length);
    } else {
      pos = source.indexOf(findTerm, pos + 1);
    }
  }
  return edits;
}

export function computeReplacements(source: string, filePath: string, spec: ReplaceSpec): TextEdit[] {
  const r = new Replacer(spec);
  let edits = isMarkupFile(filePath) ? markupEdits(source, r) : scriptEdits(source, r);
  if (edits.length === 0) {
    edits = rawTextEdits(source, r);
  }
  return edits.sort((a, b) => b.start - a.start);
}
