export function cleanToken(token: string): string {
  let cleaned = token.replace(/^(?:cn|clsx|class[nN]ames|twMerge|cx)\(/i, "");

  cleaned = cleaned
    .replace(/^\[(["'`])/, "$1")
    .replace(/(["'`])\]$/, "$1");

  cleaned = cleaned
    .replace(/^["'`{(.]*/, "")
    .replace(/["'`}),;]*$/, "");

  if (/^(?:cn|clsx|class[nN]ames|twMerge|cx)\(/i.test(cleaned)) {
    cleaned = cleanToken(cleaned);
  }

  return cleaned;
}

export function tokenize(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .map(cleanToken)
    .filter((token) => token.length > 0);
}

// A helper call (cn(...), clsx(...)) or a whitespace-bounded ?/:/&&  signals a pasted code
// fragment rather than a plain class list. ":" alone isn't checked — Tailwind variants like
// hover:bg-red-500 have no surrounding whitespace and would false-positive.
const CODE_HELPER_CALL = /\b(?:cn|clsx|class[nN]ames|twMerge|cx)\s*\(/;
const CODE_SYNTAX_TOKEN = /(?:^|\s)[?:](?:\s|$)|&&/;

function looksLikeCodeFragment(raw: string): boolean {
  return CODE_HELPER_CALL.test(raw) || CODE_SYNTAX_TOKEN.test(raw);
}

// Returns the joined contents of every quoted string, or null if there are none to extract.
function extractQuotedSegments(raw: string): string | null {
  const matches = [...raw.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)];
  if (matches.length === 0) {
    return null;
  }
  return matches.map((m) => m[1] ?? m[2] ?? m[3] ?? "").join(" ");
}

export function extractClassesFromPaste(raw: string): string {
  const trimmed = raw.trim();

  const attrMatch = trimmed.match(/\bclass(?:Name)?\s*=\s*\{?\s*["']([^"']*)["']\s*\}?/i);
  if (attrMatch) {
    return attrMatch[1];
  }

  const templateMatch = trimmed.match(/\bclass(?:Name)?\s*=\s*\{\s*`([^`]*)`\s*\}/i);
  if (templateMatch) {
    return templateMatch[1];
  }

  // A pasted code fragment mixes class strings with JS syntax — extract only what's inside
  // quotes so identifiers/operators never get treated as class names.
  if (looksLikeCodeFragment(trimmed)) {
    const quoted = extractQuotedSegments(trimmed);
    if (quoted !== null) {
      return quoted;
    }
  }

  return trimmed;
}

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

export function normalizeStyleKey(key: string): string {
  return key.replace(/-([a-z])/g, (g) => g[1]).toLowerCase();
}

export function normalizeStyleValue(val: string): string {
  let clean = val.trim().replace(/^["'`]|["'`]$/g, "").toLowerCase();
  if (clean.endsWith(";")) {
    clean = clean.slice(0, -1).trim();
  }
  const pixelMatch = clean.match(/^(\d+)px$/);
  if (pixelMatch) {
    return pixelMatch[1];
  }
  return clean;
}

export function arbitraryValueBase(cls: string): string | null {
  if (!cls.includes("[") || !cls.includes("]")) return null;
  return cls.replace(/\[[^\]]*\]/g, "[]");
}

export function buildArbitraryIndex(classes: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const cls of classes) {
    const base = arbitraryValueBase(cls);
    if (!base) continue;
    const list = index.get(base);
    if (list) {
      list.push(cls);
    } else {
      index.set(base, [cls]);
    }
  }
  return index;
}

export function isStyleInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^style\s*=/i.test(trimmed)) {
    return true;
  }
  // A bare CSS declaration list never contains JS/JSX syntax — quoted strings, ternaries,
  // logical-and, braces/parens. A pasted class-list snippet (cn("a", cond ? "b" : "c")) often
  // does, and also happens to contain a colon (from the ternary) and commas (from the args),
  // which would otherwise satisfy the heuristic below and get misparsed as inline styles.
  if (/["'`?(){}]|&&/.test(trimmed)) return false;

  const hasColon = trimmed.includes(":");
  if (!hasColon) return false;
  if (trimmed.includes(";") || trimmed.includes(",")) return true;

  const key = trimmed.split(":")[0].trim();
  return /^(width|height|min-width|min-height|max-width|max-height|font-size|font-weight|padding|margin|color|background|display|flex|position|top|bottom|left|right|border|opacity|z-index|line-height|text-align|align-items|justify-content)/i.test(key);
}

export function parsePastedStyleList(raw: string): string[] {
  let cleaned = raw.trim();
  const attrMatch = cleaned.match(/\bstyle\s*=\s*\{?\s*["'`]([^"'`]*)["'`]\s*\}?/i);
  if (attrMatch) {
    cleaned = attrMatch[1];
  } else {
    const objMatch = cleaned.match(/\bstyle\s*=\s*\{\{\s*([\s\S]*?)\s*\}\}/i);
    if (objMatch) {
      cleaned = objMatch[1];
    }
  }

  const delimiter = cleaned.includes(";") ? ";" : ",";
  const pairs = cleaned.split(delimiter);
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const pair of pairs) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) continue;

    const colonIndex = trimmedPair.indexOf(":");
    if (colonIndex === -1) continue;

    const rawKey = trimmedPair.substring(0, colonIndex).trim().replace(/['""]/g, "");
    const key = normalizeStyleKey(rawKey);

    let val = trimmedPair.substring(colonIndex + 1).trim().replace(/['"",]/g, "");
    const cleanVal = normalizeStyleValue(val);
    if (!key || !cleanVal) continue;

    const token = `style:${key}:${cleanVal}`;
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

