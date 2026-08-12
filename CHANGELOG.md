# Change Log

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
