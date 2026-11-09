const MARKUP_EXTENSIONS = new Set([
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
  ".php",
  ".erb",
  ".twig",
  ".hbs",
  ".handlebars",
]);

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

export function isMarkupFile(filePath: string): boolean {
  return MARKUP_EXTENSIONS.has(extensionOf(filePath));
}

export function isStyleFile(filePath: string): boolean {
  return STYLE_EXTENSIONS.has(extensionOf(filePath));
}
