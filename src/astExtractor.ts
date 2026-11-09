import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { isClassHelperCall, parseJs } from "./babel";
import {
  CLASS_HELPER_NAMES,
  tokenize,
  cleanToken,
  styleToken,
  parsePastedClassList,
  attributeValueFromPaste,
  unwrapClassAttribute,
} from "./classParser";
import { isMarkupFile, isStyleFile } from "./languages";
import { embeddedScriptBlocks, extractClassesFromMarkup } from "./markupExtractor";
import { SourceText, location, splitLines } from "./text";
import type { ClassLocation, ExtractedClass, ExtractionResult } from "./types";

const MAX_LOCATIONS_PER_CLASS = 8;

// ponytail: Fast regex-based class extractor for stylesheets without bringing in PostCSS/csstree. Ceiling: may match decimals or comments; upgrade path: PostCSS parser if strict CSS AST is ever needed.
function extractClassesFromStyle(source: string, filePath: string): ExtractedClass[] {
  const text = new SourceText(filePath, source);
  const found: ExtractedClass[] = [];

  const emit = (token: string, offset: number) => {
    if (!token) return;
    found.push({ className: token, location: text.locationAt(offset) });
  };

  const CLASS_SELECTOR_RE = /\.([a-zA-Z0-9_\-\\:\[\]\/\#\%]+)/g;
  let match: RegExpExecArray | null;
  while ((match = CLASS_SELECTOR_RE.exec(source)) !== null) {
    const rawCls = match[1].replace(/\\/g, "");
    const offset = match.index + 1;
    emit(rawCls, offset);
  }

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
    // Indexing wants every class it can salvage from a file that may be mid-edit. Query parsing
    // wants the opposite: a wrapper that doesn't fit must fail outright so the next one is
    // tried, instead of recovering into a garbage AST that yields junk tokens.
    ast = parseJs(source, !strict);
  } catch (err) {
    return { classes: [], parseError: err instanceof Error ? err.message : String(err) };
  }

  const sourceLines = splitLines(source);
  const found: ExtractedClass[] = [];

  const varInitializers = new Map<string, t.Node>();
  traverse(ast, {
    noScope: true,
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const id = path.node.id;
      if (id.type === "Identifier" && path.node.init) {
        varInitializers.set(id.name, path.node.init);
      }
    },
  });
  const resolvingVars = new Set<string>();

  const locationOf = (node: t.Node): ClassLocation => {
    const loc = node.loc;
    const lineIndex = loc ? loc.start.line - 1 : 0;
    const column = loc ? loc.start.column : 0;
    return { ...location(filePath, sourceLines, lineIndex, column), line: lineIndex + lineOffset };
  };

  const emit = (raw: string, node: t.Node) => {
    if (!raw) return;
    const loc = locationOf(node);
    for (const token of tokenize(raw)) {
      found.push({ className: token, location: loc });
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
        if (isClassHelperCall(node)) {
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

        const valNode = prop.value;
        if (valNode.type === "StringLiteral" || valNode.type === "NumericLiteral") {
          const token = styleToken(key, String(valNode.value));
          if (token) {
            found.push({ className: token, location: locationOf(prop.loc ? prop : node) });
          }
        }
      }
    }
  }

  traverse(ast, {
    noScope: true,
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
      if (isClassHelperCall(path.node)) {
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

export interface ParsedFile {
  classes: Set<string>;
  locations: Map<string, ClassLocation[]>;
  fastSkip: boolean;
  parseError?: string;
}

// Plain data in and out (Map/Set survive structured clone), so it runs the same inline or in a
// worker thread.
export function parseSource(source: string, filePath: string): ParsedFile {
  const classes = new Set<string>();
  const locations = new Map<string, ClassLocation[]>();
  if (!canPossiblyContainClasses(source, filePath)) {
    return { classes, locations, fastSkip: true };
  }

  // Babel can throw past its own error recovery (e.g. `Duplicate declaration` from scope
  // tracking), and one uncaught throw here used to abort the whole build.
  let result: ExtractionResult;
  try {
    result = extractClassesFromSource(source, filePath);
  } catch (err) {
    result = { classes: [], parseError: err instanceof Error ? err.message : String(err) };
  }

  for (const { className, location } of result.classes) {
    classes.add(className);
    const list = locations.get(className);
    if (list) {
      if (list.length < MAX_LOCATIONS_PER_CLASS) list.push(location);
    } else {
      locations.set(className, [location]);
    }
  }
  return { classes, locations, fastSkip: false, parseError: result.parseError };
}
