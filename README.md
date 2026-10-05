# Smart Class Search

Copy a class list out of Chrome DevTools, paste it into the sidebar or the
Command Palette, and jump straight to the component that renders it - even
when your codebase spreads those classes across `cn()`, `clsx()`,
`classnames()`, template literals, arrays, ternaries, and `&&` conditionals.

A plain text/regex search for the DevTools string will never find any of
these. Smart Class Search will.

## What's New in v0.4.9

- **Faster, non-blocking indexing**: files are parsed in background worker threads, so a full
  build finishes sooner and VS Code (IntelliSense, formatters, Git) stays responsive while it runs.
- **Sturdier indexing** (v0.4.8): one unparseable file can no longer break the build, huge and
  minified files are skipped, and the sidebar shows when an index is still building.
- **Safer replace** (v0.4.7): the plain-text fallback only replaces whole words, so `card` no
  longer rewrites `cardTitle`.
- **Stylesheets** (v0.4.5): `.css`, `.scss`, `.sass`, and `.less` class selectors and Tailwind
  `@apply` rules are indexed and searchable, and text search matches phrases across line breaks.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

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

### Editor context menu (search what you highlighted)

Select a class list in any open file, right-click, and pick **Smart Class Search**
or **Smart Class Search: Replace Class...**. The selection pre-fills the input —
it takes priority over the clipboard, and `<div class="...">` wrappers are
stripped the same way as a paste.

Run **"Smart Class Search: Find Duplicate Components"** from the Command
Palette any time to look for elements in different files that render with an
identical set of classes.

### Always-On Adaptive Text Search

Search now automatically runs class matching alongside a full source-text search (comments, JSX text, property names, strings) by default. The ranking engine intelligently adapts based on the query:
- **Prose-shaped queries** (e.g. comment searches, raw labels, or general text) float literal text matches to the top.
- **Class-heavy queries** (e.g. Tailwind lists) keep class matches on top and gate out incidental word coincidences (like a class named `border` matching a CSS property name `border:` in a style object) to keep results noise-free.
- **Multi-line phrases**: A pasted snippet still matches when the source splits it across lines or indents it differently, e.g. `className="relative" data-testid="header"` finds the same attributes written on two lines.
- **Syntactic Cleaning**: Pasting a raw code fragment (such as `cn()` or `clsx()` calls, ternaries) into the search box parses actual class strings cleanly without leaking bare JavaScript syntax (identifiers, operators like `?`, `:`, `&&`) as class names.

### Class Replacement (Interactive Preview & Selective Apply)

You can replace classes across your workspace using either the sidebar or the Command Palette:

#### Via the Sidebar (Recommended):
1. Enter the class(es) to find in the search input.
2. Enter the replacement class(es) in the **"Replace with..."** input below it (leave empty to delete).
3. Click the swap icon inside the replace input to generate a preview. The sidebar switches to a **Replace Preview** pane, displaying all matching occurrences grouped by file.
4. Each occurrence shows its line number and a side-by-side diff (`before → after`).
5. Use the checkboxes to select or deselect specific occurrences or entire files.
6. Click **"Apply (N)"** to perform the replacements. The extension re-derives edits from the current file source at the exact moment of application; if a file has changed since the preview was generated, those occurrences are safely skipped to avoid source corruption.

#### Via the Command Palette:
1. `Cmd/Ctrl+Shift+P` → **"Smart Class Search: Replace Class..."**.
2. Enter the class(es) to find and the replacement class(es) when prompted.
3. Confirm the workspace edits via a warning dialog indicating the number of affected files and occurrences.

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

### Markup files (`.vue`, `.svelte`, `.astro`, `.html`, `.php`, `.erb`, `.twig`, `.hbs`)

Non-JavaScript templates are scanned for class attributes directly, so the same paste-and-jump
workflow works outside React:

| Syntax                                            | Frameworks              |
| ------------------------------------------------- | ----------------------- |
| `class="p-4 flex"` / `class='p-4 flex'`           | HTML, Blade, ERB, Twig  |
| `:class="{ 'bg-red-500': isError }"`              | Vue                     |
| `v-bind:class="isOpen ? 'rounded-lg' : ''"`       | Vue                     |
| `x-bind:class="'shadow-md'"`                      | Alpine                  |
| `class={isOpen ? "shadow-md" : "shadow-none"}`    | Svelte, Astro           |
| `class:bg-base-200={dark}`                        | Svelte                  |
| `class:list={["gap-2", isActive && "items-center"]}` | Astro                |

`<script>` blocks in `.vue`/`.svelte` and `.astro` frontmatter are parsed as real JS/TS, so a
`const styles = cn("p-4", isBig && "mb-12")` in the script half resolves exactly as it would in a
`.tsx` file, and its classes are reported at their true line in the `.vue`/`.astro` file.

### Stylesheets (`.css`, `.scss`, `.sass`, `.less`)

Class selectors (`.btn-primary`, `.card`) and the utilities inside Tailwind `@apply` rules
are indexed, so a class defined or composed in a stylesheet is found alongside the components that
use it:

```css
.btn-primary {
  @apply px-4 py-2 rounded-lg bg-blue-600;
}
```

> [!NOTE]
> **Limitations:**
> - Variable resolution only follows assignments within the same file. Classes imported from a different file/module and referenced by name (e.g., `import { styles } from "./styles"`) still can't be resolved, since this is static single-file analysis rather than full cross-module data-flow tracking.
> - In markup, only quoted strings inside a dynamic binding are read as classes. An unquoted object key (Vue's `:class="{ active: isOn }"`) and Blade's `@class([...])` helper are not extracted.
> - Replacing inside a markup file rewrites class attributes and Svelte `class:` directives; a class living inside a `.vue`/`.svelte` `<script>` `cn()` call is handled by the plain-text fallback instead.

## Indexing & performance

The extension activates on `onStartupFinished`, so the index is already built by
the time you first search — you don't have to open the sidebar to warm it up.
That event fires *after* VS Code has finished restoring the window, so it never
delays window open. Parsing runs in background worker threads (up to half your
CPU cores, max 4), so a full build never blocks the extension host or other
extensions.

On activation, the extension loads a **persisted index cache** (a file in the
extension's workspace storage) and compares file modification times. Only
files that have changed since the last session are re-parsed, so large repos
skip the full scan on every restart. The cache is invalidated automatically
when the `include` or `exclude` settings change.

When no cache exists (first run), the extension scans the workspace once
(default: JS/TS, the markup extensions, and stylesheets listed above, excluding
`node_modules`, `.next`, `dist`, `build`, `coverage`, `.git`, `out`) and builds an in-memory index of
`class → file → locations`. After that, a `FileSystemWatcher` keeps the
index current incrementally - only the file that changed gets re-parsed. You
can force a full rebuild with **"Smart Class Search: Rebuild Index"**.

While a build runs, the status bar spins and the sidebar shows "Indexing
files…". To keep builds fast:

- Files larger than 1MB and `*.min.*` files are skipped, since they are bundles
  or vendor code rather than components.
- Files that can't contain a class (a quick text check finds no `className`,
  `style`, class helper, array, or `class` attribute) skip the full parse.
- A file that fails to parse stays in the index with no classes, so it is still
  reachable by text search and isn't re-parsed on every start. The reason is
  logged to the **Smart Class Search** output channel.

## Settings

| Setting                                  | Default                                                   | Description                                                             |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `smartClassLookup.include`               | `**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte,astro,html,htm,php,erb,twig,hbs,css,scss,sass,less}` | Files to index |
| `smartClassLookup.exclude`               | `**/{node_modules,.next,dist,build,coverage,.git,out}/**` | Files/folders to skip                                                   |
| `smartClassLookup.minScore`              | `0.3`                                                     | Minimum match score (0–1) to show a result                             |
| `smartClassLookup.maxResults`            | `25`                                                      | Max number of ranked results shown                                     |
| `smartClassLookup.enablePreview`         | `true`                                                    | Live preview of the file when navigating results (Quick Pick & Sidebar) |
| `smartClassLookup.duplicateMinClasses`   | `3`                                                       | Minimum shared classes for "Find Duplicate Components" to report a group |

## Developing

```bash
npm install
npm run test        # tsc to out/ + runs the extractor/matcher smoke tests
npm run bundle      # esbuild to dist/extension.js + dist/parsePool.js — what the extension actually loads
npm run watch       # the same bundle in watch mode, for the Extension Development Host
npm run typecheck   # tsc --noEmit
```

The extension entry point is the esbuild bundle at `dist/extension.js`, so run
`npm run bundle` (or `npm run watch`) at least once before pressing `F5`.
`dist/parsePool.js` is the parse worker, bundled separately because worker
threads load it by path. The `out/` tree produced by `npm run compile` exists
only so the smoke tests can require each module in isolation.

To try it in VS Code: open this folder, press `F5` to launch an Extension
Development Host with the extension loaded, open any project that uses
Tailwind (React, Vue, Svelte, Astro, plain HTML, …) in that window, and run
**"Smart Class Search"** from the Command Palette.
