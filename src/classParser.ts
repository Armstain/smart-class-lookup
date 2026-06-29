/**
 * Turns a raw, pasted "class soup" (e.g. copied straight out of Chrome
 * DevTools) into a clean, deduplicated list of individual Tailwind class
 * tokens.
 *
 * This same tokenizer is reused when extracting classes out of source code,
 * so that "relative z-[1050] bg-base-200" and the equivalent code spread
 * across multiple cn() arguments normalize to the exact same tokens.
 */

/**
 * Split a blob of whitespace-separated class names into individual tokens.
 *
 * Tailwind tokens never contain unescaped whitespace -- even arbitrary
 * values use underscores instead of spaces (e.g. `grid-cols-[1fr_300px]`) --
 * so a plain whitespace split is safe and is exactly what Tailwind itself
 * does internally.
 */
export function tokenize(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .replace(/[\r\n\t]+/g, " ") // newlines/tabs -> spaces
    .split(/\s+/) // collapse duplicate spaces
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Parse the string the user pasted into the input box into a deduplicated,
 * order-preserving list of class tokens.
 */
export function parsePastedClassList(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokenize(raw)) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}
