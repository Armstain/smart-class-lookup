import { parse, type ParserPlugin } from "@babel/parser";
import type * as t from "@babel/types";
import { CLASS_HELPER_NAMES } from "./classParser";

const PLUGINS: ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
  "classProperties",
  "objectRestSpread",
  "optionalChaining",
  "nullishCoalescingOperator",
];

export function parseJs(source: string, errorRecovery: boolean): t.File {
  return parse(source, { sourceType: "module", plugins: PLUGINS, errorRecovery });
}

const HELPERS = new Set(CLASS_HELPER_NAMES);

export function isClassHelperCall(node: t.CallExpression): boolean {
  const callee = node.callee;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && callee.property.type === "Identifier"
      ? callee.property.name
      : undefined;
  return name !== undefined && HELPERS.has(name);
}
