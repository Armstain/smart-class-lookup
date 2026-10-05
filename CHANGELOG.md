# Change Log

## [0.4.9]

### Improved
- **Faster indexing, editor stays responsive**: Files are now parsed in background worker threads instead of on the extension host. A first-time or full rebuild finishes noticeably faster on multi-core machines, and other extensions (IntelliSense, formatters, Git) no longer stall while the index builds.

### Fixed
- **Smaller package**: A stray local `.kilo/` worktree was being bundled into the `.vsix` (39 files / 4MB). It is now excluded, bringing the package back to 10 files / 1.6MB.

### Technical details: how indexing got faster
- **The bottleneck was a single thread.** Babel parsing is synchronous CPU work. The indexer already read files 16 at a time, but every parse still ran one after another on the extension host thread, which every extension shares. Concurrent async I/O couldn't help, because the slow part never awaited anything.
- **Parsing moved to a worker pool** (`src/parsePool.ts`). The main thread still does file I/O through `vscode.workspace.fs` and keeps the index maps. Each worker receives `{ source, filePath }` and returns the file's class set and locations. `Map`/`Set` survive structured clone, so nothing is serialized by hand.
- **The pool is sized so it doesn't slow down the machine.** It uses `min(4, cores / 2)` workers, with at least 1, so half the CPU always stays free for the editor. Workers start on demand: a warm start that re-parses only a few changed files spins up only as many workers as it needs.
- **Workers last only as long as a build.** Each worker loads its own copy of Babel (roughly 800KB of code plus its heap), so the pool is torn down once the build finishes. File-watcher events parse a single file at a time, which is cheap enough to stay inline.
- **One parse function shared by both paths.** `parseSource()` in `astExtractor.ts` holds the textual pre-check, the error guard and the location grouping, and runs identically inline and in a worker. `parsePool.ts` doubles as the worker entry point and is bundled separately to `dist/parsePool.js`, so the pool and the code it runs can't drift apart.
- **Failures stay contained.** If a worker crashes on a file, that file is recorded as a parse error and a new worker takes its place, instead of the whole build aborting.
- **One fewer `stat` per changed file.** On an incremental start, the stat used for the cache check is passed straight to the indexer instead of being repeated.

## [0.4.8]

### Fixed
- **A single bad file no longer breaks indexing**: Babel's scope tracking could throw (e.g. `Duplicate declaration` from a repeated import) and abort the whole build. Traversals now skip scope tracking, and any file that still fails to parse stays indexed with no classes, so plain-text search can still reach it.
- **Stuck "indexing…" status**: A failed build left the status bar spinning and never started the file watcher. Builds now always finish cleanly and log the error.
- **Watcher exclude rules**: File events from excluded folders were filtered with a rough `{a,b}` brace match. They now use the same glob as the `exclude` setting, so custom patterns like `**/*.min.*` work.
- **Leaked watcher listeners**: Each change to the `include`/`exclude` settings left the previous watcher's event listeners registered. They are now disposed along with the watcher.
- **Deleted files left in the cache**: Deleting a file now also updates the saved cache.
- **Accurate modification times**: Files skipped by the fast pre-check were stamped with the time they were indexed. They now record the file's real mtime, which the incremental cache compares against.
- **Variant class lists read as inline CSS**: A paste like `flex md:gap-4` was mistaken for `prop: value` style input. A space before the first colon now marks it as a class list.
- **Replace missed files loaded from cache**: Cached index entries have no source in memory, so the replace preview skipped them. Their source is now loaded on demand.

### Improved
- **Huge and minified files are skipped**: Files over 1MB and `*.min.*` files are no longer parsed, so a stray bundle or vendor file can't stall indexing for minutes.
- **Index cache moved out of workspace state**: The cache now lives in a file in the extension's workspace storage instead of VS Code's SQLite state store, which is loaded eagerly and isn't meant for megabytes of data. The old entry is cleared automatically.
- **Indexing status in the sidebar**: The sidebar shows "Indexing files…" while a build runs, and an empty result says "Still indexing, results may be incomplete" instead of "No components match".

## [0.4.7]

### Fixed
- **Replace no longer corrupts longer identifiers**: The raw-text fallback used when the AST doesn't find a match replaced the target anywhere in the source, including inside longer names (`card` inside `cardTitle`). It now replaces whole words only.
- **Stale sidebar results**: The active search now re-runs when the index updates, so saves and renames show up without retyping the query.

### Changed
- **Replace button redesign**: The sidebar's replace button is now an icon-only swap button placed inside the replace input, matching the toolbar buttons.

## [0.4.6]

### Changed
- **Separate publishers per store**: Releases are published as `armstain` on the VS Code Marketplace and `nazmul-hossain-adnan` on Open VSX. There were no functional changes.

## [0.4.5]

### Added
- **Stylesheet Support**: Added indexing, search, and class extraction for CSS, SCSS, SASS, and LESS stylesheet files (`.css`, `.scss`, `.sass`, `.less`).
- **Tailwind `@apply` & CSS Class Selector Extraction**: Extracted CSS selectors (`.btn-primary`, `.card`) and Tailwind utility tokens from `@apply` rules in stylesheets.
- **Multi-line & Whitespace-Flexible Phrase Search**: Enhanced text search to match phrases spanning multiple lines, indentation, and varied whitespace.
- **Sliding-Window Multi-line Term Matching**: Added multi-line sliding window term coverage for search queries spread across consecutive code lines.

### Improved
- **Workspace-Wide Text Search**: Included non-class files in workspace index so text search can reach all included workspace files without requiring class definitions.
- **Stop-Word Term Matching**: Optimized regex boundaries for short stop-words with pre-compiled pattern caching.

## [0.4.0]

### Added
- **Markup file support**: `.vue`, `.svelte`, `.astro`, `.html`/`.htm`, `.php` (Blade), `.erb`, `.twig`, and `.hbs` files are now indexed, searched, and replaced in. Understands static `class=""`, Vue `:class` / `v-bind:class`, Alpine `x-bind:class`, Svelte `class={...}` and `class:foo={cond}`, and Astro `class:list={[...]}`.
- **Embedded script parsing**: `<script>` blocks in `.vue`/`.svelte` and `.astro` frontmatter run through the same Babel path as a `.tsx` file, so `cn()`, `clsx()`, ternaries, arrays, and local variables resolve there too — reported at their true line in the host file.
- **Editor context menu**: right-click a selection to run **Smart Class Search** or **Smart Class Search: Replace Class...**. An editor selection now takes priority over the clipboard when pre-filling the search input.
- **Template interpolation awareness**: `{{ $classes }}`, `<?php … ?>`, and `{% … %}` inside a class attribute are skipped, while the literal classes beside them are still indexed — and a replacement never overwrites the interpolation.

### Fixed
- **Arbitrary values containing quotes**: `content-['hi']` and `before:content-['']` were being truncated to `content-[` by the token cleaner, which mistook the trailing `']` for pasted-array punctuation. Affected JSX as well as markup.
- **Partial replacements in markup**: markup files no longer go through Babel's JSX error recovery, which silently skipped whatever it could not parse and could leave a replace half-applied. Class attributes are now edited from the same scanner the indexer uses, which also fixes multi-class replace targets (previously only the first target class was replaced).

### Changed
- Default `smartClassLookup.include` now covers the markup extensions plus `.mjs`/`.cjs`/`.mts`/`.cts`. **This invalidates the cached index, so the first launch after upgrading performs one full rebuild.**
- Publisher changed to `armstain`; the extension ID is now `armstain.smart-class-lookup`.
- **Bundled with esbuild.** The entry point moved from `out/extension.js` to a single minified `dist/extension.js`, so `node_modules` is no longer shipped. The package dropped from 317 files / 2.9MB to 9 files / 1.4MB.
- Added the `license: MIT` field and removed `private: true`, which had been blocking `vsce publish`.
- Removed a dead reference to `@vscode/codicons` in the sidebar webview — the stylesheet URI was built but never used, and the package was never a dependency.

## [0.3.3]

### Fixed & Improved
- **Universal Replace Engine**: Expanded class and text replacement to cover all JSX attributes (`href`, `src`, `id`), string literals, template literals, imports, JSX text, and non-AST files.
- **Source-Aware Candidate Filtering**: Candidate file selection for Replace now searches file source text in addition to indexed CSS classes, guaranteeing text search targets (like `/trip-planner`) match candidate files.
- **Replace Preview Live Editor Previewing**: Added hover live previewing and click-to-open navigation for occurrences and file headers in the Replace Preview pane.

## [0.3.2]

### Added & Improved
- **Instant Cold Startup**: Optimized workspace indexing with non-blocking event-loop yields to ensure the VS Code sidebar view opens instantly.
- **Smart Identifier & Phrase Search**: Added phrase variant matching for camelCase, snake_case, and kebab-case code identifiers (e.g. `"Sign in"` matches `signIn`, `sign_in`, `sign-in`, `signin`).
- **Stop-Word Word-Boundaries**: Added word-boundary checks for common short stop-words (`in`, `on`, `at`, `is`, `to`) to eliminate false matches inside unrelated words.
- **Sidebar Line Snippets**: Displayed line location snippets with highlighted search matches directly below all search result items.
- **Smooth Editor Live Preview**: Enabled non-intrusive live editor previewing when hovering or navigating search results in the sidebar.
