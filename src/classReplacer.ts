import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { tokenize } from "./classParser";

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
  replacementClasses: string[]
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

  if (!changed) {
    return { newValue: value, changed: false };
  }

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

export function computeReplacements(
  source: string,
  targetClasses: string[],
  replacementClasses: string[]
): TextEdit[] {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: BABEL_PLUGINS,
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const edits: TextEdit[] = [];
  const editedStarts = new Set<number>();

  const handleStringValue = (value: string, start: number, end: number, isQuasi = false) => {
    if (editedStarts.has(start)) return;

    const { newValue, changed } = replaceClassesInString(value, targetClasses, replacementClasses);
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

  const varInitializers = new Map<string, t.Node>();
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const id = path.node.id;
      if (id.type === "Identifier" && path.node.init) {
        varInitializers.set(id.name, path.node.init);
      }
    },
  });

  const CLASS_HELPER_NAMES = new Set(["cn", "clsx", "classnames", "classNames", "twMerge", "cx"]);
  const resolvingVars = new Set<string>();

  function processNode(node: t.Node | null | undefined): void {
    if (!node) return;

    switch (node.type) {
      case "StringLiteral": {
        if (typeof node.start === "number" && typeof node.end === "number") {
          handleStringValue(node.value, node.start, node.end, false);
        }
        break;
      }
      case "TemplateLiteral": {
        for (const quasi of node.quasis) {
          if (typeof quasi.start === "number" && typeof quasi.end === "number") {
            handleStringValue(quasi.value.raw, quasi.start, quasi.end, true);
          }
        }
        for (const expr of node.expressions) {
          processNode(expr as t.Node);
        }
        break;
      }
      case "JSXExpressionContainer": {
        processNode(node.expression as t.Node);
        break;
      }
      case "ParenthesizedExpression": {
        processNode(node.expression);
        break;
      }
      case "ConditionalExpression": {
        processNode(node.consequent);
        processNode(node.alternate);
        break;
      }
      case "LogicalExpression": {
        processNode(node.left);
        processNode(node.right);
        break;
      }
      case "ArrayExpression": {
        for (const element of node.elements) {
          if (element) {
            if (element.type === "SpreadElement") {
              processNode(element.argument);
            } else {
              processNode(element);
            }
          }
        }
        break;
      }
      case "ObjectExpression": {
        for (const prop of node.properties) {
          if (prop.type !== "ObjectProperty") continue;
          if (!prop.computed) {
            const key = prop.key;
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
          processNode(prop.value as t.Node);
        }
        break;
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
            processNode(arg as t.Node);
          }
        }
        break;
      }
      case "Identifier": {
        const name = node.name;
        if (varInitializers.has(name) && !resolvingVars.has(name)) {
          resolvingVars.add(name);
          processNode(varInitializers.get(name));
          resolvingVars.delete(name);
        }
        break;
      }
    }
  }

  traverse(ast, {
    JSXAttribute(path: NodePath<t.JSXAttribute>) {
      const name = path.node.name;
      if (name.type === "JSXIdentifier" && name.name === "className") {
        processNode(path.node.value as t.Node | null);
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
          processNode(arg as t.Node);
        }
      }
    },
    ArrayExpression(path: NodePath<t.ArrayExpression>) {
      processNode(path.node);
    },
  });

  return edits.sort((a, b) => b.start - a.start);
}
