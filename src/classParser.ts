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

export function isStyleInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^style\s*=/i.test(trimmed)) {
    return true;
  }
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

