import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { tokenize, normalizeStyleKey, normalizeStyleValue } from "./classParser";
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

  // First pass: record `const x = ...` initializers so className={x} / style={x}
  // can be resolved back to the value assigned to x elsewhere in the file.
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
            line: lineIndex,
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
      if (name.name === "className") {
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
