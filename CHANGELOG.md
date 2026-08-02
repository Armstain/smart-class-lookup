# Change Log

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
