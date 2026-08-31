import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import {
  tokenize,
  cleanToken,
  normalizeStyleKey,
  normalizeStyleValue,
  parsePastedClassList,
  attributeValueFromPaste,
  unwrapClassAttribute,
} from "./classParser";
import {
  embeddedScriptBlocks,
  extractClassesFromMarkup,
  isMarkupFile,
} from "./markupExtractor";
import type { ClassLocation, ExtractedClass, ExtractionResult } from "./types";

export type { ExtractedClass, ExtractionResult } from "./types";

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);

export function isStyleFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return STYLE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// ponytail: Fast regex-based class extractor for stylesheets without bringing in PostCSS/csstree. Ceiling: may match decimals or comments; upgrade path: PostCSS parser if strict CSS AST is ever needed.
export function extractClassesFromStyle(source: string, filePath: string): ExtractedClass[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const sourceLines = source.split(/\r?\n/);
  const found: ExtractedClass[] = [];

  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const emit = (token: string, offset: number) => {
    if (!token) return;
    const line = lineAt(offset);
    const location: ClassLocation = {
      file: filePath,
      line,
      column: offset - lineStarts[line],
      context: (sourceLines[line] ?? token).trim().slice(0, 140),
    };
    found.push({ className: token, location });
  };

  // 1. Class selectors: .foo, .gm-style-iw
  const CLASS_SELECTOR_RE = /\.([a-zA-Z0-9_\-\\:\[\]\/\#\%]+)/g;
  let match: RegExpExecArray | null;
  while ((match = CLASS_SELECTOR_RE.exec(source)) !== null) {
    const rawCls = match[1].replace(/\\/g, "");
    const offset = match.index + 1;
    emit(rawCls, offset);
  }

  // 2. Tailwind @apply rules: @apply p-4 flex;
  const APPLY_RE = /@apply\s+([^;{}]+)/g;
  while ((match = APPLY_RE.exec(source)) !== null) {
    const applyBody = match[1];
    const applyStart = match.index + match[0].indexOf(applyBody);
    const tokens = applyBody.split(/\s+/).filter(Boolean);
    let cursor = 0;
    for (const token of tokens) {
      const tokenIdx = applyBody.indexOf(token, cursor);
      const tokenOffset = applyStart + (tokenIdx !== -1 ? tokenIdx : 0);
      cursor = tokenIdx !== -1 ? tokenIdx + token.length : cursor;
      emit(cleanToken(token), tokenOffset);
    }
  }

  return found;
}

const CLASS_HELPER_NAMES = new Set([
  "cn",
  "clsx",
  "classnames",
  "classNames",
  "twMerge",
  "cx",
]);

const BABEL_PLUGINS: import("@babel/parser").ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
];

// Cheap textual pre-check so callers can skip the full Babel parse for files that could
// not possibly yield a class: extractClassesFromSource only ever emits from a `className`/
// `style` JSX attribute, a call to one of CLASS_HELPER_NAMES, or *any* array literal (`[`)
// in the file. Deliberately conservative — a false "maybe" just costs an unneeded parse;
// a false "never" would silently drop real classes, which must never happen.
export function canPossiblyContainClasses(source: string, filePath?: string): boolean {
  if (filePath && isMarkupFile(filePath)) {
    return source.includes("class");
  }
  if (filePath && isStyleFile(filePath)) {
    return source.includes(".") || source.includes("@apply");
  }
  if (source.includes("className") || source.includes("style") || source.includes("[")) {
    return true;
  }
  for (const name of CLASS_HELPER_NAMES) {
    if (source.includes(name)) return true;
  }
  return false;
}

// A pasted query is a fragment, not a program, so it is re-wrapped into the smallest valid JSX
// that gives it meaning and handed to the same extractor the indexer uses. Order matters: the
// expression forms are tried before the template form, because a `cn(...)` paste is valid inside
// `className={...}` but would otherwise be read as literal template text and leak `cn(`/`&&`
// as class names.
const QUERY_WRAPPERS: Array<(query: string) => string> = [
  (query) => `<div className={${query}}/>`,
  (query) => `<div className={cn(${query})}/>`,
  (query) => `<div className={\`${query}\`}/>`,
];

/**
 * Class names in a pasted search query, resolved through the AST rather than by pattern-matching
 * the text. Because it is the same traversal the indexer runs, every shape the indexer supports
 * (template literals, ternaries, `&&`, arrays, object keys, `cn()`/`clsx()` nesting) behaves
 * identically on the query side — including ignoring what is *not* a class, such as an
 * identifier or the value a ternary condition compares against.
 */
export function parseClassQuery(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // `className={...}` unwraps to its expression; a class attribute inside a larger markup paste
  // (`<div class="...">`) contributes only its value. Otherwise the paste is the query.
  const candidate = unwrapClassAttribute(trimmed) ?? attributeValueFromPaste(trimmed) ?? trimmed;
  // Unbalanced backticks are common when a template literal is selected by eye; they would
  // otherwise break every wrapper.
  const query = candidate.replace(/^`+/, "").replace(/`+$/, "");

  for (const wrap of QUERY_WRAPPERS) {
    const { classes, parseError } = extractClassesFromJs(wrap(query), "<query>", 0, true);
    if (parseError || classes.length === 0) continue;

    const seen = new Set<string>();
    for (const { className } of classes) seen.add(className);
    return [...seen];
  }

  // Nothing parsed — fall back to text tokenization (CSS selectors, stray punctuation, prose).
  return parsePastedClassList(raw);
}

export function extractClassesFromSource(
  source: string,
  filePath: string
): ExtractionResult {
  if (isStyleFile(filePath)) {
    return { classes: extractClassesFromStyle(source, filePath) };
  }
  if (isMarkupFile(filePath)) {
    const classes = extractClassesFromMarkup(source, filePath);
    // .vue/.svelte <script> blocks and .astro frontmatter are real JS/TS — run them through the
    // same Babel path so cn()/clsx()/ternaries/local variables resolve there too.
    for (const { code, lineOffset } of embeddedScriptBlocks(source)) {
      classes.push(...extractClassesFromJs(code, filePath, lineOffset).classes);
    }
    return { classes };
  }
  return extractClassesFromJs(source, filePath, 0);
}

function extractClassesFromJs(
  source: string,
  filePath: string,
  lineOffset: number,
  strict = false
): ExtractionResult {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: BABEL_PLUGINS,
      // Indexing wants every class it can salvage from a file that may be mid-edit. Query parsing
      // wants the opposite: a wrapper that doesn't fit must fail outright so the next one is
      // tried, instead of recovering into a garbage AST that yields junk tokens.
      errorRecovery: !strict,
    });
  } catch (err) {
    return { classes: [], parseError: err instanceof Error ? err.message : String(err) };
  }

  const sourceLines = source.split(/\r?\n/);
  const found: ExtractedClass[] = [];

  const varInitializers = new Map<string, t.Node>();
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const id = path.node.id;
      if (id.type === "Identifier" && path.node.init) {
        varInitializers.set(id.name, path.node.init);
      }
    },
  });
  const resolvingVars = new Set<string>();

  const emit = (raw: string, node: t.Node) => {
    if (!raw) return;
    const loc = node.loc;
    const lineIndex = loc ? loc.start.line - 1 : 0;
    const contextLine = sourceLines[lineIndex] ?? raw;
    const location: ClassLocation = {
      file: filePath,
      line: lineIndex + lineOffset,
      column: loc ? loc.start.column : 0,
      context: contextLine.trim().slice(0, 140),
    };
    for (const token of tokenize(raw)) {
      found.push({ className: token, location });
    }
  };

  function collectFromExpression(node: t.Node | null | undefined): void {
    if (!node) return;

    switch (node.type) {
      case "StringLiteral": {
        emit(node.value, node);
        return;
      }

      case "TemplateLiteral": {
        for (const quasi of node.quasis) {
          emit(quasi.value.raw, quasi);
        }
        for (const expr of node.expressions) {
          collectFromExpression(expr as t.Node);
        }
        return;
      }

      case "JSXExpressionContainer": {
        collectFromExpression(node.expression as t.Node);
        return;
      }

      case "ParenthesizedExpression": {
        collectFromExpression(node.expression);
        return;
      }

      case "ConditionalExpression": {
        collectFromExpression(node.consequent);
        collectFromExpression(node.alternate);
        return;
      }

      case "LogicalExpression": {
        collectFromExpression(node.left);
        collectFromExpression(node.right);
        return;
      }

      case "ArrayExpression": {
        for (const element of node.elements) {
          if (!element) continue;
          if (element.type === "SpreadElement") {
            collectFromExpression(element.argument);
          } else {
            collectFromExpression(element);
          }
        }
        return;
      }

      case "ObjectExpression": {
        for (const prop of node.properties) {
          if (prop.type !== "ObjectProperty" || prop.computed) continue;
          const key = prop.key;
          if (key.type === "StringLiteral") {
            emit(key.value, key);
          } else if (key.type === "Identifier") {
            emit(key.name, key);
          }
        }
        return;
      }

      case "CallExpression": {
        const callee = node.callee;
        const calleeName =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && callee.property.type === "Identifier"
            ? callee.property.name
            : undefined;

        if (calleeName && CLASS_HELPER_NAMES.has(calleeName)) {
          for (const arg of node.arguments) {
            collectFromExpression(arg as t.Node);
          }
        }
        return;
      }

      case "Identifier": {
        resolveVariable(node.name, collectFromExpression);
        return;
      }

      default:
        return;
    }
  }

  // Resolves `const x = <init>` back to <init> so className={x}/style={x} can be
  // followed. Guards against cycles (const a = b; const b = a;) via resolvingVars.
  function resolveVariable(name: string, visit: (node: t.Node | null | undefined) => void): void {
    const init = varInitializers.get(name);
    if (!init || resolvingVars.has(name)) return;
    resolvingVars.add(name);
    visit(init);
    resolvingVars.delete(name);
  }

  function collectStylesFromExpression(node: t.Node | null | undefined): void {
    if (!node) return;

    if (node.type === "JSXExpressionContainer") {
      collectStylesFromExpression(node.expression as t.Node);
      return;
    }

    if (node.type === "Identifier") {
      resolveVariable(node.name, collectStylesFromExpression);
      return;
    }

    if (node.type === "ObjectExpression") {
      for (const prop of node.properties) {
        if (prop.type !== "ObjectProperty") continue;

        let key: string | undefined;
        if (prop.key.type === "Identifier" && !prop.computed) {
          key = prop.key.name;
        } else if (prop.key.type === "StringLiteral") {
          key = prop.key.value;
        }

        if (!key) continue;

        const normalizedKey = normalizeStyleKey(key);
        const valNode = prop.value;

        if (valNode.type === "StringLiteral" || valNode.type === "NumericLiteral") {
          const val = String(valNode.value);
          const cleanVal = normalizeStyleValue(val);
          if (!cleanVal) continue;

          const loc = prop.loc || node.loc;
          const lineIndex = loc ? loc.start.line - 1 : 0;
          const contextLine = sourceLines[lineIndex] ?? `${key}: ${valNode.value}`;
          const location: ClassLocation = {
            file: filePath,
            line: lineIndex + lineOffset,
            column: loc ? loc.start.column : 0,
            context: contextLine.trim().slice(0, 140),
          };
          found.push({ className: `style:${normalizedKey}:${cleanVal}`, location });
        }
      }
    }
  }

  traverse(ast, {
    JSXAttribute(path: NodePath<t.JSXAttribute>) {
      const name = path.node.name;
      if (name.type !== "JSXIdentifier") {
        return;
      }
      if (name.name === "className" || name.name === "class") {
        collectFromExpression(path.node.value as t.Node | null);
        path.skip();
      } else if (name.name === "style") {
        collectStylesFromExpression(path.node.value as t.Node | null);
        path.skip();
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      const calleeName =
        callee.type === "Identifier"
          ? callee.name
          : callee.type === "MemberExpression" && callee.property.type === "Identifier"
          ? callee.property.name
          : undefined;

      if (calleeName && CLASS_HELPER_NAMES.has(calleeName)) {
        for (const arg of path.node.arguments) {
          collectFromExpression(arg as t.Node);
        }
        path.skip();
      }
    },

    ArrayExpression(path: NodePath<t.ArrayExpression>) {
      collectFromExpression(path.node);
      path.skip();
    },
  });

  return { classes: found };
}
