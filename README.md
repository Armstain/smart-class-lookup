# Smart Class Lookup

Copy a class list out of Chrome DevTools, paste it into one command, and jump
straight to the component that renders it — even when your codebase spreads
those classes across `cn()`, `clsx()`, `classnames()`, template literals,
arrays, ternaries, and `&&` conditionals.

```html
<!-- copied from DevTools -->
<div class="relative z-[1050] bg-base-200 px-5 pb-5 pt-4 rounded-2xl shadow-md mb-12">
```

```tsx
// lives in your repo, classes scattered across cn()
className={cn(
  "relative",
  isOpen && "z-[1050]",
  "bg-base-200",
  mobile ? "px-5" : "px-4",
  "pb-5 pt-4",
  "rounded-2xl shadow-md",
)}
```

A plain text/regex search for the DevTools string will never find this.
Smart Class Lookup will.

## How it works

1. **Run the command.** `Cmd/Ctrl+Shift+P` → **"Smart Class Lookup"**.
2. **Paste your class list.** The input box is pre-filled from your clipboard
   if it already contains a class list or HTML element (just press `Enter`).
   You can also paste a full DevTools element like
   `<div class="p-4 flex rounded-lg">` and the extension strips the HTML
   wrapper automatically — only the class names are used.
3. **Navigate the results.** As you arrow through the Quick Pick, the
   matching file opens in a live preview tab with the matched lines
   highlighted in real time. Press `Escape` to cancel and restore your
   original editor.
4. **Pick an occurrence.** Files with matches on multiple distinct lines are
   expanded into separate entries — one per line — so you can jump to the
   exact component occurrence in one click.

A status bar item (bottom right) shows how many files are currently indexed
and doubles as a shortcut to run the search.

## Smart paste detection

The input box accepts any of the following — no manual trimming required:

| What you paste | What is used |
|---|---|
| `p-4 flex rounded-lg` | the whole string |
| `<div class="p-4 flex">` | `p-4 flex` |
| `class="p-4 flex"` | `p-4 flex` |
| `className="p-4 flex"` | `p-4 flex` |
| `` className={`p-4 flex`} `` | `p-4 flex` |

## Supported Syntax & Patterns

The extension statically analyzes your files to extract class names from complex, programmatic code structures:

- **Standard classes**: `className="foo bar"` or `className={'foo bar'}`
- **Utility functions**: `cn(...)`, `clsx(...)`, `classnames(...)`, `cx(...)`, `twMerge(...)` (including nested calls)
- **Template literals**: Interpolated strings like `` `bg-white ${isOpen ? "shadow-md" : ""}` ``
- **Ternary operators**: `condition ? "bg-red-500" : "bg-blue-500"`
- **Logical conditions**: `isOpen && "rounded-lg"`
- **Arrays**: `["p-4", isOpen && "rounded-lg"]`
- **Object notation**: `clsx({ "bg-red-500": isError })`
- **Tailwind features**: Arbitrary values (`w-[320px]`), variants (`hover:`, `md:`), and important flags (`!mt-4`)

> [!NOTE]
> **Limitation:** Since this uses static analysis, classes defined in a separate file/variable and referenced by name (e.g., `className={styles}`) cannot be resolved.


## Indexing & performance

On activation, the extension loads a **persisted index cache** from VS Code's
workspace storage and compares file modification times. Only files that have
changed since the last session are re-parsed, so large repos skip the full
scan on every restart. The cache is invalidated automatically when the
`include` or `exclude` settings change.

When no cache exists (first run), the extension scans the workspace once
(default: `**/*.{ts,tsx,js,jsx}`, excluding `node_modules`, `.next`, `dist`,
`build`, `coverage`, `.git`, `out`) and builds an in-memory index of
`class → file → locations`. After that, a `FileSystemWatcher` keeps the
index current incrementally — only the file that changed gets re-parsed. You
can force a full rebuild with **"Smart Class Lookup: Rebuild Index"**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `smartClassLookup.include` | `**/*.{ts,tsx,js,jsx}` | Files to index |
| `smartClassLookup.exclude` | `**/{node_modules,.next,dist,build,coverage,.git,out}/**` | Files/folders to skip |
| `smartClassLookup.minScore` | `0.15` | Minimum match score (0–1) to show a result |
| `smartClassLookup.maxResults` | `25` | Max number of ranked results shown |

## Project layout

```
src/
  extension.ts     activation, command registration, status bar, clipboard pre-fill
  astExtractor.ts  Babel AST walk: finds class strings + their locations
  classParser.ts   tokenizes/dedupes the pasted string; strips HTML/JSX wrappers
  indexer.ts       builds + incrementally maintains the workspace index; persists cache
  matcher.ts       order-independent similarity scoring & ranking
  quickPick.ts     results UI: live preview, multi-location items, jump-to-file
test/
  smoke.js         functional tests for the extractor, parser, and matcher (no vscode dep)
```

## Developing

```bash
npm install
npm run test        # compiles + runs the extractor/matcher smoke tests
npm run watch       # tsc --watch, for use with the Extension Development Host
```

To try it in VS Code: open this folder, press `F5` to launch an Extension
Development Host with the extension loaded, open any React/Next.js project
in that window, and run **"Smart Class Lookup"** from the Command
Palette.

## Possible next steps

- Resolve simple local variable assignments (`const styles = cn(...)`) one
  hop, for the common "computed once, spread via `{...styles}`" pattern.
- Add a "copy matched file path" / "copy className" action to each Quick
  Pick item.
- Support `.vue`, `.svelte`, and `.html` files via a regex-based fallback
  extractor for `class="..."` attributes.
