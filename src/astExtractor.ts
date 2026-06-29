import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { tokenize } from "./classParser";
import type { ClassLocation } from "./types";

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

export interface ExtractionResult {
  classes: ExtractedClass[];
  parseError?: string;
}

const BABEL_PLUGINS: import("@babel/parser").ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
];

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

  const sourceLines = source.split(/\r?\n/);
  const found: ExtractedClass[] = [];

  const emit = (raw: string, node: t.Node) => {
    if (!raw) return;
    const loc = node.loc;
    const lineIndex = loc ? loc.start.line - 1 : 0;
    const contextLine = sourceLines[lineIndex] ?? raw;
    const location: ClassLocation = {
      file: filePath,
      line: lineIndex,
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

      default:
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

    ArrayExpression(path: NodePath<t.ArrayExpression>) {
      collectFromExpression(path.node);
      path.skip();
    },
  });

  return { classes: found };
}
