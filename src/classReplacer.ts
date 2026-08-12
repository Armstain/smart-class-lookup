import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { tokenize } from "./classParser";
import { isMarkupFile, scanClassAttributes, scanClassDirectives } from "./markupExtractor";

const BABEL_PLUGINS: import("@babel/parser").ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
];

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

export function replaceClassesInString(
  value: string,
  targetClasses: string[],
  replacementClasses: string[],
  rawTarget?: string,
  rawReplacement?: string
): { newValue: string; changed: boolean } {
  if (!value.trim()) {
    return { newValue: value, changed: false };
  }

  // Split by whitespace while preserving delimiters
  const parts = value.split(/(\s+)/);
  const targetSet = new Set(targetClasses.map((t) => t.toLowerCase()));
  let firstMatchIndex = -1;
  let changed = false;

  const processedParts = parts.map((part, index) => {
    const trimmed = part.trim();
    if (trimmed && targetSet.has(trimmed.toLowerCase())) {
      changed = true;
      if (firstMatchIndex === -1) {
        firstMatchIndex = index;
        return replacementClasses.join(" ");
      } else {
        return "";
      }
    }
    return part;
  });

  if (changed) {
    let newValue = processedParts.join("");
    const leadingSpace = /^\s/.test(value);
    const trailingSpace = /\s$/.test(value);

    newValue = newValue.replace(/\s+/g, " ").trim();

    if (leadingSpace && newValue) {
      newValue = " " + newValue;
    }
    if (trailingSpace && newValue) {
      newValue = newValue + " ";
    }

    return { newValue, changed: true };
  }

  // Fallback: raw target string replacement inside string value
  if (rawTarget && rawTarget.trim() && value.includes(rawTarget)) {
    const newValue = value.split(rawTarget).join(rawReplacement ?? "");
    return { newValue, changed: true };
  }

  return { newValue: value, changed: false };
}

// Class replacement for markup (.vue/.svelte/.astro/.html/...). Babel can only reach these
// files through JSX error recovery, which silently skips whatever it fails to parse and would
// leave a partial replace behind — so class attributes are edited from the same scanner the
// markup indexer uses.
// ponytail: class attributes only — a class inside a .vue/.svelte <script> cn() call is left to
// the raw-text fallback below. Parse the embedded script blocks here if that becomes a real ask.
function computeMarkupReplacements(
  source: string,
  targetClasses: string[],
  replacementClasses: string[],
  rawTarget?: string,
  rawReplacement?: string
): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const attr of scanClassAttributes(source)) {
    for (const segment of attr.segments) {
      const { newValue, changed } = replaceClassesInString(
        segment.text,
        targetClasses,
        replacementClasses,
        rawTarget,
        rawReplacement
      );
      if (changed) {
        edits.push({ start: segment.start, end: segment.end, newText: newValue });
      }
    }
  }

  const targetSet = new Set(targetClasses.map((t) => t.toLowerCase()));
  for (const directive of scanClassDirectives(source)) {
    if (targetSet.has(directive.text.toLowerCase())) {
      edits.push({
        start: directive.start,
        end: directive.end,
        newText: replacementClasses.join(" "),
      });
    }
  }

  return edits;
}

export function computeReplacements(
  source: string,
  targetClasses: string[],
  replacementClasses: string[],
  rawTarget?: string,
  rawReplacement?: string,
  filePath?: string
): TextEdit[] {
  const markup = filePath !== undefined && isMarkupFile(filePath);

  let ast: t.File | null = null;
  if (!markup) {
    try {
      ast = parse(source, {
        sourceType: "module",
        plugins: BABEL_PLUGINS,
        errorRecovery: true,
      });
    } catch {
      ast = null;
    }
  }

  const edits: TextEdit[] = markup
    ? computeMarkupReplacements(source, targetClasses, replacementClasses, rawTarget, rawReplacement)
    : [];
  const editedStarts = new Set<number>();

  const handleStringValue = (value: string, start: number, end: number, isQuasi = false) => {
    if (editedStarts.has(start)) return;

    const { newValue, changed } = replaceClassesInString(
      value,
      targetClasses,
      replacementClasses,
      rawTarget,
      rawReplacement
    );
    if (changed) {
      editedStarts.add(start);
      if (isQuasi) {
        edits.push({ start, end, newText: newValue });
      } else {
        const rawText = source.slice(start, end);
        const quoteStart = rawText[0] ?? '"';
        const quoteEnd = rawText[rawText.length - 1] ?? '"';
        edits.push({ start, end, newText: quoteStart + newValue + quoteEnd });
      }
    }
  };

  if (ast) {
    traverse(ast, {
      StringLiteral(path: NodePath<t.StringLiteral>) {
        if (typeof path.node.start === "number" && typeof path.node.end === "number") {
          handleStringValue(path.node.value, path.node.start, path.node.end, false);
        }
      },
      TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
        for (const quasi of path.node.quasis) {
          if (typeof quasi.start === "number" && typeof quasi.end === "number") {
            handleStringValue(quasi.value.raw, quasi.start, quasi.end, true);
          }
        }
      },
      JSXText(path: NodePath<t.JSXText>) {
        const val = path.node.value;
        if (typeof path.node.start === "number" && typeof path.node.end === "number") {
          handleStringValue(val, path.node.start, path.node.end, true);
        }
      },
      ObjectProperty(path: NodePath<t.ObjectProperty>) {
        if (!path.node.computed) {
          const key = path.node.key;
          if (key.type === "StringLiteral" && typeof key.start === "number" && typeof key.end === "number") {
            handleStringValue(key.value, key.start, key.end, false);
          } else if (key.type === "Identifier" && typeof key.start === "number" && typeof key.end === "number") {
            const targetSet = new Set(targetClasses.map((t) => t.toLowerCase()));
            if (targetSet.has(key.name.toLowerCase()) && !editedStarts.has(key.start)) {
              editedStarts.add(key.start);
              edits.push({
                start: key.start,
                end: key.end,
                newText: replacementClasses.join(" "),
              });
            }
          }
        }
      },
    });
  }

  // Fallback if AST failed or produced no edits but rawTarget / targetClasses exist in source
  if (edits.length === 0 && (rawTarget?.trim() || targetClasses.length > 0)) {
    const findTerm = rawTarget?.trim() || targetClasses[0];
    if (findTerm && source.includes(findTerm)) {
      const replaceTerm = rawReplacement ?? replacementClasses.join(" ");
      let pos = source.indexOf(findTerm);
      while (pos !== -1) {
        edits.push({
          start: pos,
          end: pos + findTerm.length,
          newText: replaceTerm,
        });
        pos = source.indexOf(findTerm, pos + findTerm.length);
      }
    }
  }

  return edits.sort((a, b) => b.start - a.start);
}

