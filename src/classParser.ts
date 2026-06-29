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
 * Try to extract just the class string from a pasted snippet that may be a
 * full HTML element or a JSX attribute assignment.
 *
 * Handles all of these inputs, returning only the class value string:
 *   <div class="p-4 flex bg-red-50">
 *   className="p-4 flex"
 *   class='p-4 flex'
 *   className={`p-4 flex`}    (backtick template literal form)
 *
 * Returns the original string unchanged if none of these patterns match, so
 * plain class lists ("p-4 flex rounded") pass through untouched.
 *
 * ponytail: simple regex extraction — covers the >95% DevTools copy case.
 * Does not parse arbitrary JSX expressions (className={cn(...)}) since those
 * can't be extracted with regex; users should paste the resolved class list
 * from the browser instead.
 */
export function extractClassesFromPaste(raw: string): string {
  const trimmed = raw.trim();

  // `class="..."` or `className="..."` (with single or double quotes)
  const attrMatch = trimmed.match(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/i);
  if (attrMatch) {
    return attrMatch[1];
  }

  // `className={\`...\`}` — backtick template literal in JSX
  const templateMatch = trimmed.match(/\bclass(?:Name)?\s*=\s*\{`([^`]*)`\}/i);
  if (templateMatch) {
    return templateMatch[1];
  }

  return trimmed;
}

/**
 * Parse the string the user pasted into the input box into a deduplicated,
 * order-preserving list of class tokens.
 *
 * Automatically strips HTML/JSX wrappers before tokenizing, so the user can
 * paste anything from Chrome DevTools (a full element, a class attribute, or
 * just the raw class list) and get sensible results.
 */
export function parsePastedClassList(raw: string): string[] {
  const cleaned = extractClassesFromPaste(raw);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokenize(cleaned)) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}
