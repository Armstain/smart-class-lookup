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
