# Smart Class Search

Copy a class list out of Chrome DevTools, paste it into the sidebar or the
Command Palette, and jump straight to the component that renders it - even
when your codebase spreads those classes across `cn()`, `clsx()`,
`classnames()`, template literals, arrays, ternaries, and `&&` conditionals.

A plain text/regex search for the DevTools string will never find any of
these. Smart Class Search will.

## Examples

**`cn()` with conditionals**

```html
<!-- copied from DevTools -->
<div
  class="relative z-[1050] bg-base-200 px-5 pb-5 pt-4 rounded-2xl shadow-md mb-12"
></div>
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

**`clsx()` object notation**

```html
<div class="bg-red-500 text-white p-4"></div>
```

```tsx
className={clsx({
  "bg-red-500": isError,
  "text-white": true,
  "p-4": true,
})}
```

**Local variable resolution**

```html
<div class="p-4 flex rounded-lg"></div>
```

```tsx
const cardStyles = cn("p-4", "flex", "rounded-lg");
// ...later in the same file
<div className={cardStyles}>
```

**Template literal + ternary**

```html
<div class="bg-white shadow-md"></div>
```

```tsx
className={`bg-white ${isOpen ? "shadow-md" : ""}`}
```

## How it works

You can search from the sidebar or the Command Palette - both share the same
index, so pick whichever fits the moment.

### Sidebar (stays open, updates as you type)

1. Click the search icon in the Activity Bar to open the **Class Search**
   panel (or click the status bar item at the bottom right).
2. Paste your class list or a full DevTools element - the panel pre-fills
   from your clipboard as soon as it opens.
3. Results update live as you type. Hover a result to preview it inline
   (toggle with "Live preview on hover"), or click it to jump straight there.
4. Files with matches on multiple lines expand into a list under the result -
   click any line to jump to that exact occurrence.
5. Use the ⧉ icons to copy a result's file path or matched class list without
   leaving the panel.

### Command Palette (one-off, self-closing)

1. `Cmd/Ctrl+Shift+P` → **"Smart Class Search"**.
2. Paste your class list. The input box is pre-filled from your clipboard if
   it already contains a class list or HTML element (just press `Enter`).
   You can also paste a full DevTools element like
   `<div class="p-4 flex rounded-lg">` and the extension strips the HTML
   wrapper automatically - only the class names are used.
3. Navigate the results. As you arrow through the Quick Pick, the matching
   file opens in a live preview tab with the matched lines highlighted in
   real time. Press `Escape` to cancel and restore your original editor.
4. Pick an occurrence. Files with matches on multiple distinct lines are
   expanded into separate entries - one per line - so you can jump to the
   exact component occurrence in one click.
5. Check the breakdown. Each result's detail line shows the classes that
   matched exactly, any that only near-matched (arbitrary values like
   `w-[120px]` vs `w-[124px]`), and any that are still missing, so you can
   judge at a glance whether it's the right component.

Run **"Smart Class Search: Find Duplicate Components"** from the Command
Palette any time to look for elements in different files that render with an
identical set of classes.

## Smart paste detection

Both the sidebar and the Command Palette accept any of the following - no
manual trimming required:

| What you paste             | What is used     |
| --------------------------- | ---------------- |
| `p-4 flex rounded-lg`      | the whole string |
| `<div class="p-4 flex">`   | `p-4 flex`       |
| `class="p-4 flex"`         | `p-4 flex`       |
| `className="p-4 flex"`     | `p-4 flex`       |
| ``className={`p-4 flex`}`` | `p-4 flex`       |

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
- **Local variables**: `const styles = cn("p-4", "flex"); <div className={styles}>` and the same for `style={styleObj}` — resolved back to the value assigned in the same file

> [!NOTE]
> **Limitation:** Variable resolution only follows assignments within the same file. Classes imported from a different file/module and referenced by name (e.g., `import { styles } from "./styles"`) still can't be resolved, since this is static single-file analysis rather than full cross-module data-flow tracking.

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
index current incrementally - only the file that changed gets re-parsed. You
can force a full rebuild with **"Smart Class Search: Rebuild Index"**.

## Settings

| Setting                                  | Default                                                   | Description                                                             |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `smartClassLookup.include`               | `**/*.{ts,tsx,js,jsx}`                                    | Files to index                                                          |
| `smartClassLookup.exclude`               | `**/{node_modules,.next,dist,build,coverage,.git,out}/**` | Files/folders to skip                                                   |
| `smartClassLookup.minScore`              | `0.3`                                                     | Minimum match score (0–1) to show a result                             |
| `smartClassLookup.maxResults`            | `25`                                                      | Max number of ranked results shown                                     |
| `smartClassLookup.enablePreview`         | `true`                                                    | Live preview of the file when navigating results (Quick Pick & Sidebar) |
| `smartClassLookup.duplicateMinClasses`   | `3`                                                       | Minimum shared classes for "Find Duplicate Components" to report a group |

## Project layout

```
src/
  extension.ts       activation, command registration, status bar, clipboard pre-fill
  astExtractor.ts    Babel AST walk: finds class strings + their locations, resolves local variables
  classParser.ts     tokenizes/dedupes the pasted string; strips HTML/JSX wrappers; arbitrary-value helpers
  indexer.ts         builds + incrementally maintains the workspace index; persists cache
  matcher.ts         order-independent similarity scoring & ranking, with near-match credit
  duplicates.ts      finds elements with identical class sets across different files
  quickPick.ts       results UI: live preview, multi-location items, copy actions, jump-to-file
  sidebarProvider.ts persistent sidebar search webview
test/
  smoke.js           functional tests for the extractor, parser, matcher, and duplicate finder (no vscode dep)
```

## Developing

```bash
npm install
npm run test        # compiles + runs the extractor/matcher smoke tests
npm run watch       # tsc --watch, for use with the Extension Development Host
```

To try it in VS Code: open this folder, press `F5` to launch an Extension
Development Host with the extension loaded, open any React/Next.js project
in that window, and run **"Smart Class Search"** from the Command
Palette.

## Possible next steps

- Support `.vue`, `.svelte`, and `.html` files via a regex-based fallback
  extractor for `class="..."` attributes.
- Resolve variables imported from another file, not just declared in the
  same file.

## What's new

- **Local variable resolution** — `const styles = cn("p-4", "flex"); <div className={styles}>`
  is now followed back to its declaration, so classes computed once and reused
  via a variable are indexed correctly (works for both `className={x}` and
  `style={x}`, one file, any number of hops).
- **Near-match scoring for arbitrary values** — pasting `w-[124px]` now
  partially matches a file that has `w-[120px]` (same utility, different
  bracketed value) instead of scoring it as a total miss. Near matches are
  shown separately from exact matches and missing classes in both the Quick
  Pick and the sidebar.
- **"Find Duplicate Components" command** — scans the index for elements in
  different files that share the exact same set of classes, so you can spot
  copy-pasted markup that's a candidate for extraction into a shared
  component.
- **Copy actions** — copy a result's file path or its matched class list
  straight from the Quick Pick (hover a result for the button icons) or the
  sidebar (the ⧉ icon next to each result).
