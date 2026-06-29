/**
 * AST-based extraction of Tailwind class strings out of TS/TSX/JS/JSX source.
 *
 * Rather than relying on regex (which falls apart the moment classes are
 * spread across cn()/clsx() calls, template literals, ternaries, arrays,
 * etc.), we parse each file into a real AST with @babel/parser and walk it
 * with @babel/traverse.
 *
 * Strategy
 * --------
 * We look for three kinds of "entry points" in the tree:
 *
 *  1. A JSX `className` attribute (`className="..."`, `className={...}`).
 *  2. A call to a known class-list helper (`cn`, `clsx`, `classnames`, ...)
 *     -- even when it's NOT inside a className attribute, e.g.
 *     `const cardClasses = cn("p-4", isOpen && "shadow-md")`.
 *  3. A standalone array literal of strings, e.g.
 *     `const classes = ["p-4", isOpen && "rounded-lg"]` -- even when it's
 *     not passed into a className/cn()/clsx() at all.
 *
 * From each entry point we run a small hand-written recursive walker
 * (`collectFromExpression`) over the *value* expression, because here we
 * already know we're looking at "stuff that produces class names", and we
 * can confidently recurse into template literals, ternaries, &&/||, arrays,
 * nested cn()/clsx() calls, and clsx-style `{ "class-name": condition }`
 * objects -- without needing full data-flow/type analysis.
 *
 * To avoid double-counting a `cn(...)` call that lives inside a className
 * attribute (which the JSXAttribute visitor already drills into), we call
 * `path.skip()` after handling a node, which stops Babel's traversal from
 * descending into it again via the generic CallExpression visitor.
 */

import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { tokenize } from "./classParser";
import type { ClassLocation } from "./types";

/** Helper function names that are known to combine/concatenate class names. */
const CLASS_HELPER_NAMES = new Set([
  "cn",
  "clsx",
  "classnames",
  "classNames",
  "twMerge",
  "cx",
]);

export interface ExtractedClass {
  className: string;
  location: ClassLocation;
}

/** Result of parsing one file. */
export interface ExtractionResult {
  classes: ExtractedClass[];
  /** True if the file failed to parse (syntax error, unsupported syntax, etc). */
  parseError?: string;
}

/** Babel parser plugins. We always enable both jsx and typescript -- the
 * TypeScript plugin is a syntactic superset that also parses plain JS fine,
 * and enabling jsx unconditionally lets us handle .js files that contain
 * JSX (common in older Next.js / CRA projects). */
const BABEL_PLUGINS: import("@babel/parser").ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
];

/**
 * Parse a single file's source text and extract every Tailwind class token
 * found inside className attributes and class-helper calls, along with the
 * source location it came from.
 */
export function extractClassesFromSource(
  source: string,
  filePath: string
): ExtractionResult {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: BABEL_PLUGINS,
      errorRecovery: true,
    });
  } catch (err) {
    return { classes: [], parseError: err instanceof Error ? err.message : String(err) };
  }

  const found: ExtractedClass[] = [];

  /** Push every whitespace-delimited token found in `raw` as a match, all
   * sharing the same source location (the location of the literal/template
   * piece they came from). */
  const emit = (raw: string, node: t.Node) => {
    if (!raw) return;
    const loc = node.loc;
    const location: ClassLocation = {
      file: filePath,
      line: loc ? loc.start.line - 1 : 0, // babel is 1-based, vscode is 0-based
      column: loc ? loc.start.column : 0,
      context: raw.trim().slice(0, 140),
    };
    for (const token of tokenize(raw)) {
      found.push({ className: token, location });
    }
  };

  /**
   * Recursively walk an *expression* that is known to be (part of) a class
   * name producer, pulling out every literal string we can find.
   *
   * This intentionally only handles statically-resolvable shapes. Anything
   * else (plain identifiers referencing variables defined elsewhere,
   * function calls we don't recognize, member expressions, etc.) is a
   * dead end we can't resolve without full data-flow analysis, and is
   * silently skipped.
   */
  function collectFromExpression(node: t.Node | null | undefined): void {
    if (!node) return;

    switch (node.type) {
      case "StringLiteral": {
        emit(node.value, node);
        return;
      }

      case "TemplateLiteral": {
        // Literal pieces between ${...} interpolations.
        for (const quasi of node.quasis) {
          emit(quasi.value.raw, quasi);
        }
        // Recurse into each ${...} expression -- this is what lets us
        // handle `bg-white ${isOpen ? "shadow-md" : ""}`.
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
        // `condition ? "a" : "b"` -- we don't know which branch will run,
        // so index both; either is a legitimate class the file can render.
        collectFromExpression(node.consequent);
        collectFromExpression(node.alternate);
        return;
      }

      case "LogicalExpression": {
        // `isOpen && "rounded-lg"` / `a || b` -- the left side is usually
        // the condition (not a class string) but recursing into it too is
        // harmless: non-string nodes are simply ignored below.
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
        // clsx/classnames object form: { "bg-red-500": isError, flex: true }
        // The condition's runtime value doesn't matter for indexing -- if a
        // class appears as a key, the file is a legitimate place that class
        // could render.
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
        // Unknown function call -- can't statically resolve its return
        // value, so there's nothing more we can do here.
        return;
      }

      default:
        // Identifiers, member expressions, numeric literals, etc. -- not
        // statically resolvable class sources. Skip.
        return;
    }
  }

  traverse(ast, {
    JSXAttribute(path: NodePath<t.JSXAttribute>) {
      const name = path.node.name;
      if (name.type !== "JSXIdentifier" || name.name !== "className") {
        return;
      }
      collectFromExpression(path.node.value as t.Node | null);
      // Don't let the generic visitors below re-process a cn()/clsx() call
      // or array we just handled as part of this attribute's value.
      path.skip();
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

    // Standalone class arrays, e.g. `const classes = ["p-4", isOpen &&
    // "rounded-lg"]`, that aren't already wrapped in className=... or a
    // cn()/clsx() call (those are handled -- and skipped here -- above).
    ArrayExpression(path: NodePath<t.ArrayExpression>) {
      collectFromExpression(path.node);
      path.skip();
    },
  });

  return { classes: found };
}
