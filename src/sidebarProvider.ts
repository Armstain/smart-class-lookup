import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceIndexer } from "./indexer";
import { parsePastedClassList, extractClassesFromPaste, isStyleInput, parsePastedStyleList } from "./classParser";
import { rankFiles } from "./matcher";
import { openAndHighlight, clearDecorations } from "./quickPick";
import type { SearchResult } from "./types";
import { filterCandidateFiles, collectReplacements, applySelectedEdits, type AppliedEdit } from "./replacePreview";

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private previewEditor?: vscode.TextEditor;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexer: WorkspaceIndexer
  ) {
    this.indexer.onDidUpdate(() => {
      if (this.view) {
        this.view.webview.postMessage({ type: "indexUpdated", fileCount: this.indexer.fileCount });
      }
    });

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("smartClassLookup.enablePreview")) {
        const enabled = vscode.workspace.getConfiguration("smartClassLookup").get<boolean>("enablePreview", true);
        this.view?.webview.postMessage({ type: "previewConfigChanged", enabled });
      }
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Listen to messages from the webview view
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "search": {
          const rawInput = data.value as string;
          if (!rawInput.trim()) {
            webviewView.webview.postMessage({ type: "results", results: [] });
            return;
          }
          const isStyle = isStyleInput(rawInput);
          const inputClasses = isStyle ? parsePastedStyleList(rawInput) : parsePastedClassList(rawInput);
          const cfg = vscode.workspace.getConfiguration("smartClassLookup");
          const minScore = cfg.get<number>("minScore", 0.15);
          const maxResults = cfg.get<number>("maxResults", 25);

          const results = rankFiles(inputClasses, this.indexer.getIndex(), {
            minScore,
            maxResults,
            // Style inputs match structurally, not as literal text.
            rawInput: isStyle ? undefined : rawInput
          });

          // Map results to webview-friendly format (handling Set/Map serialization)
          const webviewResults = results.map((r) => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const relativePath = workspaceFolder
              ? path.relative(workspaceFolder.uri.fsPath, r.file)
              : r.file;
            return {
              file: r.file,
              fileName: path.basename(r.file),
              relativePath,
              score: r.score,
              matchType: r.matchType ?? "class",
              textScore: r.textScore,
              matchedCount: r.matchedCount,
              totalInputCount: r.totalInputCount,
              matchedClasses: r.matchedClasses,
              unmatchedClasses: r.unmatchedClasses,
              nearMatches: r.nearMatches,
              locations: r.locations.map((loc) => ({
                line: loc.line,
                column: loc.column,
                context: loc.context,
              })),
            };
          });

          webviewView.webview.postMessage({ type: "results", results: webviewResults });
          break;
        }
        case "previewReplace": {
          const target = data.target as string;
          const replacement = data.replacement as string;
          if (!target || !this.indexer) return;

          const isStyle = isStyleInput(target);
          const targetClasses = isStyle ? parsePastedStyleList(target) : parsePastedClassList(target);
          const replacementClasses = isStyle ? parsePastedStyleList(replacement) : parsePastedClassList(replacement);

          if (targetClasses.length === 0) {
            vscode.window.showWarningMessage("Smart Class Search: invalid target classes.");
            return;
          }

          const index = this.indexer.getIndex();
          const candidateFiles = filterCandidateFiles(index, targetClasses);
          if (candidateFiles.length === 0) {
            webviewView.webview.postMessage({ type: "replacePreview", target, replacement, occurrences: [] });
            return;
          }

          const sources = await this.readSources(candidateFiles);
          const occurrences = collectReplacements(sources, targetClasses, replacementClasses);

          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          const webviewOccurrences = occurrences.map((o) => ({
            key: o.key,
            file: o.file,
            fileName: path.basename(o.file),
            relativePath: workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, o.file) : o.file,
            line: o.line,
            before: o.before,
            after: o.after,
          }));

          webviewView.webview.postMessage({
            type: "replacePreview",
            target,
            replacement,
            occurrences: webviewOccurrences,
          });
          break;
        }
        case "applyReplace": {
          const target = data.target as string;
          const replacement = data.replacement as string;
          const selectedKeys = new Set<string>((data.selectedKeys as string[]) ?? []);
          if (!target || !this.indexer || selectedKeys.size === 0) return;

          const isStyle = isStyleInput(target);
          const targetClasses = isStyle ? parsePastedStyleList(target) : parsePastedClassList(target);
          const replacementClasses = isStyle ? parsePastedStyleList(replacement) : parsePastedClassList(replacement);

          if (targetClasses.length === 0) {
            vscode.window.showWarningMessage("Smart Class Search: invalid target classes.");
            return;
          }

          const index = this.indexer.getIndex();
          const candidateFiles = filterCandidateFiles(index, targetClasses);
          // Re-read current source rather than reusing the preview: a changed file's occurrence
          // won't reproduce the same key, so it's dropped and reported as skipped.
          const sources = await this.readSources(candidateFiles);
          const { applied, skippedCount } = applySelectedEdits(sources, targetClasses, replacementClasses, selectedKeys);

          if (applied.length === 0) {
            vscode.window.showInformationMessage(
              skippedCount > 0
                ? "Smart Class Replace: selected occurrences are no longer present (file changed since preview) — nothing applied."
                : "Smart Class Replace: nothing selected to apply."
            );
            return;
          }

          const editsByFile = new Map<string, AppliedEdit[]>();
          for (const edit of applied) {
            const list = editsByFile.get(edit.file) ?? [];
            list.push(edit);
            editsByFile.set(edit.file, list);
          }

          const workspaceEdit = new vscode.WorkspaceEdit();
          for (const [file, edits] of editsByFile) {
            const uri = vscode.Uri.file(file);
            const document = await vscode.workspace.openTextDocument(uri);
            for (const edit of edits) {
              const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
              workspaceEdit.replace(uri, range, edit.newText);
            }
          }

          const success = await vscode.workspace.applyEdit(workspaceEdit);
          if (success) {
            const skippedNote = skippedCount > 0 ? ` (${skippedCount} skipped — file changed since preview)` : "";
            vscode.window.showInformationMessage(
              `Smart Class Replace: applied ${applied.length} occurrence(s) in ${editsByFile.size} file(s)${skippedNote}.`
            );
            webviewView.webview.postMessage({ type: "resultsUpdated" });
          } else {
            vscode.window.showErrorMessage("Smart Class Replace: Failed to apply edits.");
          }
          break;
        }
        case "preview": {
          const result = data.result as SearchResult;
          const locationIndex = data.locationIndex as number;
          this.previewEditor = await openAndHighlight(result, locationIndex, true);
          break;
        }
        case "open": {
          const result = data.result as SearchResult;
          const locationIndex = data.locationIndex as number;
          await openAndHighlight(result, locationIndex, false);
          this.previewEditor = undefined;
          break;
        }
        case "togglePreview": {
          const enabled = data.enabled as boolean;
          const cfg = vscode.workspace.getConfiguration("smartClassLookup");
          await cfg.update("enablePreview", enabled, vscode.ConfigurationTarget.Global);
          break;
        }
        case "clearPreview": {
          if (this.previewEditor) {
            clearDecorations(this.previewEditor);
            this.previewEditor = undefined;
          }
          break;
        }
        case "copy": {
          const text = data.text as string;
          if (text) {
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage("$(check) Copied to clipboard", 2000);
          }
          break;
        }
        case "readClipboard": {
          try {
            const text = await vscode.env.clipboard.readText();
            if (text && text.trim().length > 0) {
              if (isStyleInput(text)) {
                webviewView.webview.postMessage({ type: "clipboardText", text: text.trim() });
              } else if (!/[{};()]/.test(text)) {
                const cleaned = extractClassesFromPaste(text);
                webviewView.webview.postMessage({ type: "clipboardText", text: cleaned });
              }
            }
          } catch {
            
          }
          break;
        }
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        webviewView.webview.postMessage({ type: "viewVisible", fileCount: this.indexer.fileCount });
      }
    });
  }

  // Reads current document text, including unsaved editor buffers, skipping unreadable files.
  private async readSources(files: string[]): Promise<Map<string, string>> {
    const sources = new Map<string, string>();
    for (const file of files) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        sources.set(file, document.getText());
      } catch {
        // skip
      }
    }
    return sources;
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css")
    );

    const config = vscode.workspace.getConfiguration("smartClassLookup");
    const enablePreview = config.get<boolean>("enablePreview", true);
    const previewChecked = enablePreview ? "checked" : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      padding: 10px;
      color: var(--vscode-sideBar-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, #1e1e1e);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
    }

    .search-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
      flex-shrink: 0;
    }

    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    input[type="text"] {
      width: 100%;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 6px 28px 6px 8px;
      border-radius: 2px;
      box-sizing: border-box;
      outline: none;
    }

    input[type="text"]:focus {
      border: 1px solid var(--vscode-focusBorder, #007acc);
    }

    .replace-wrapper {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }

    .replace-wrapper input[type="text"] {
      flex-grow: 1;
      padding-right: 8px;
    }

    .replace-btn {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #ffffff);
      border: none;
      padding: 6px 12px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }

    .replace-btn:hover {
      background: var(--vscode-button-hoverBackground, #0062a3);
    }

    .clear-btn {
      position: absolute;
      right: 6px;
      background: none;
      border: none;
      color: var(--vscode-input-foreground, #cccccc);
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0;
      opacity: 0.7;
    }

    .clear-btn:hover {
      opacity: 1;
    }

    .toggle-container {
      display: flex;
      align-items: center;
      margin-top: 4px;
      margin-bottom: 2px;
      flex-shrink: 0;
    }

    .toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      cursor: pointer;
      user-select: none;
    }

    .toggle-label input[type="checkbox"] {
      cursor: pointer;
      margin: 0;
      width: 13px;
      height: 13px;
      accent-color: var(--vscode-settings-checkboxBackground, #007acc);
    }

    .status-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .results-container {
      flex-grow: 1;
      overflow-y: auto;
      margin: 0 -10px;
      padding: 0 10px;
    }

    .result-item {
      display: flex;
      flex-direction: column;
      padding: 6px 8px;
      margin-bottom: 2px;
      border-radius: 3px;
      cursor: pointer;
      user-select: none;
    }

    .result-item:hover {
      background-color: var(--vscode-list-hoverBackground, #2a2d2e);
    }

    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-weight: 600;
      color: var(--vscode-foreground, #cccccc);
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .match-percent {
      font-size: 11px;
      color: var(--vscode-charts-green, #89d185);
      white-space: nowrap;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .match-percent.text-match {
      color: var(--vscode-charts-blue, #3794ff);
    }

    .match-tag {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 4px;
      border-radius: 2px;
      background: rgba(55, 148, 255, 0.15);
      color: var(--vscode-charts-blue, #3794ff);
      font-weight: 600;
    }

    .file-path {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #858585);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    .locations-list {
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .location-item {
      display: flex;
      align-items: center;
      padding: 3px 6px 3px 18px;
      font-size: 11px;
      color: var(--vscode-sideBar-foreground, #cccccc);
      border-radius: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.85;
    }

    .location-item:hover {
      background-color: var(--vscode-list-activeSelectionBackground, #37373d);
      color: var(--vscode-list-activeSelectionForeground, #ffffff);
      opacity: 1;
    }

    .location-line {
      color: var(--vscode-textLink-foreground, #3794ff);
      font-weight: bold;
      margin-right: 6px;
      flex-shrink: 0;
    }

    .location-snippet {
      font-family: var(--vscode-editor-font-family, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .matched-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
      font-size: 10px;
    }

    .matched-label {
      color: var(--vscode-charts-green, #89d185);
      opacity: 0.8;
      font-weight: 500;
    }

    .matched-class {
      background: rgba(137, 209, 133, 0.15);
      color: var(--vscode-charts-green, #89d185);
      padding: 1px 4px;
      border-radius: 2px;
    }

    .unmatched-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
      font-size: 10px;
    }

    .unmatched-label {
      color: var(--vscode-errorForeground, #f48771);
      opacity: 0.8;
      font-weight: 500;
    }

    .unmatched-class {
      background: rgba(244, 135, 113, 0.15);
      color: var(--vscode-errorForeground, #f48771);
      padding: 1px 4px;
      border-radius: 2px;
      text-decoration: line-through;
    }

    .near-match-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
      font-size: 10px;
    }

    .near-match-label {
      color: var(--vscode-charts-yellow, #cca700);
      opacity: 0.8;
      font-weight: 500;
    }

    .near-match-class {
      background: rgba(204, 167, 0, 0.15);
      color: var(--vscode-charts-yellow, #cca700);
      padding: 1px 4px;
      border-radius: 2px;
    }

    .copy-btn {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground, #858585);
      cursor: pointer;
      opacity: 0.7;
      padding: 0 2px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .copy-btn:hover {
      opacity: 1;
      color: var(--vscode-foreground, #cccccc);
    }

    .no-results {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #858585);
    }

    .replace-preview-container {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      min-height: 0;
    }

    .replace-preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-widget-border, #454545);
      flex-shrink: 0;
    }

    .replace-preview-title {
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .replace-preview-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }

    .replace-apply-btn, .replace-cancel-btn {
      border: none;
      padding: 4px 10px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }

    .replace-apply-btn {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #ffffff);
    }

    .replace-apply-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, #0062a3);
    }

    .replace-apply-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .replace-cancel-btn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #cccccc);
    }

    .replace-cancel-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    .replace-preview-list {
      flex-grow: 1;
      overflow-y: auto;
      margin: 0 -10px;
      padding: 8px 10px 0;
    }

    .replace-file-group {
      margin-bottom: 10px;
    }

    .replace-file-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 2px;
      cursor: pointer;
      user-select: none;
    }

    .replace-file-header input[type="checkbox"] {
      cursor: pointer;
      margin: 0;
      flex-shrink: 0;
    }

    .replace-file-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .replace-file-path {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #858585);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .replace-occurrence {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 3px 2px 3px 20px;
      cursor: pointer;
      user-select: none;
      border-radius: 2px;
    }

    .replace-occurrence:hover {
      background-color: var(--vscode-list-hoverBackground, #2a2d2e);
    }

    .replace-occurrence input[type="checkbox"] {
      cursor: pointer;
      margin: 2px 0 0;
      flex-shrink: 0;
    }

    .replace-occurrence-body {
      min-width: 0;
      flex-grow: 1;
    }

    .replace-occurrence-line {
      font-size: 10px;
      color: var(--vscode-textLink-foreground, #3794ff);
      font-weight: bold;
      margin-right: 4px;
    }

    .replace-occurrence-snippet {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }

    .replace-before {
      color: var(--vscode-errorForeground, #f48771);
      text-decoration: line-through;
      opacity: 0.85;
    }

    .replace-arrow {
      color: var(--vscode-descriptionForeground, #858585);
      margin: 0 4px;
    }

    .replace-after {
      color: var(--vscode-charts-green, #89d185);
    }
  </style>
</head>
<body>
  <div class="search-container">
    <div class="input-wrapper">
      <input type="text" id="search-input" placeholder="Paste class list or HTML element..." autocomplete="off">
      <button class="clear-btn" id="clear-btn" title="Clear input">×</button>
    </div>
    <div class="input-wrapper replace-wrapper">
      <input type="text" id="replace-input" placeholder="Replace with..." autocomplete="off">
      <button class="replace-btn" id="replace-btn" title="Preview occurrences before replacing">Replace…</button>
    </div>
    <div class="toggle-container">
      <label class="toggle-label">
        <input type="checkbox" id="hover-preview-toggle" ${previewChecked}>
        <span>Live preview on hover</span>
      </label>
    </div>
    <div class="status-text" id="status-text">Indexing status...</div>
  </div>

  <div class="results-container" id="results-container">
    <div class="no-results">Type or paste classes to search</div>
  </div>

  <div class="replace-preview-container" id="replace-preview-container" style="display:none;">
    <div class="replace-preview-header">
      <div class="replace-preview-title" id="replace-preview-title"></div>
      <div class="replace-preview-actions">
        <button class="replace-cancel-btn" id="replace-cancel-btn">Cancel</button>
        <button class="replace-apply-btn" id="replace-apply-btn">Apply (0)</button>
      </div>
    </div>
    <div class="replace-preview-list" id="replace-preview-list"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-btn');
    const replaceInput = document.getElementById('replace-input');
    const replaceBtn = document.getElementById('replace-btn');
    const statusText = document.getElementById('status-text');
    const resultsContainer = document.getElementById('results-container');
    const hoverPreviewToggle = document.getElementById('hover-preview-toggle');
    const replacePreviewContainer = document.getElementById('replace-preview-container');
    const replacePreviewTitle = document.getElementById('replace-preview-title');
    const replacePreviewList = document.getElementById('replace-preview-list');
    const replaceCancelBtn = document.getElementById('replace-cancel-btn');
    const replaceApplyBtn = document.getElementById('replace-apply-btn');

    let currentFileCount = 0;
    let selectedReplaceKeys = new Set();
    let currentReplaceTarget = '';
    let currentReplaceReplacement = '';

    replaceBtn.addEventListener('click', () => {
      const target = searchInput.value;
      const replacement = replaceInput.value;
      if (target.trim()) {
        vscode.postMessage({
          type: 'previewReplace',
          target: target,
          replacement: replacement
        });
      }
    });

    function closeReplacePreview() {
      replacePreviewContainer.style.display = 'none';
      resultsContainer.style.display = '';
    }

    replaceCancelBtn.addEventListener('click', () => {
      closeReplacePreview();
    });

    replaceApplyBtn.addEventListener('click', () => {
      if (selectedReplaceKeys.size === 0) return;
      vscode.postMessage({
        type: 'applyReplace',
        target: currentReplaceTarget,
        replacement: currentReplaceReplacement,
        selectedKeys: Array.from(selectedReplaceKeys)
      });
    });

    vscode.postMessage({ type: 'readClipboard' });

    hoverPreviewToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'togglePreview', enabled: hoverPreviewToggle.checked });
    });

    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      // Search box doubles as the replace "find" field — an open preview is now stale.
      if (replacePreviewContainer.style.display !== 'none') {
        closeReplacePreview();
      }
      const val = e.target.value;
      clearBtn.style.display = val ? 'flex' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ type: 'search', value: val });
      }, 100);
    });

    replaceInput.addEventListener('input', () => {
      if (replacePreviewContainer.style.display !== 'none') {
        closeReplacePreview();
      }
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      searchInput.focus();
      vscode.postMessage({ type: 'search', value: '' });
      vscode.postMessage({ type: 'clearPreview' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'results':
          renderResults(message.results);
          break;
        case 'resultsUpdated':
          closeReplacePreview();
          vscode.postMessage({ type: 'search', value: searchInput.value });
          break;
        case 'replacePreview':
          renderReplacePreview(message.target, message.replacement, message.occurrences);
          break;
        case 'indexUpdated':
        case 'viewVisible':
          currentFileCount = message.fileCount;
          statusText.textContent = \`Index contains \${currentFileCount} files\`;
          break;
        case 'previewConfigChanged':
          hoverPreviewToggle.checked = message.enabled;
          break;
        case 'clipboardText':
          if (!searchInput.value.trim()) {
            searchInput.value = message.text;
            clearBtn.style.display = 'flex';
            vscode.postMessage({ type: 'search', value: message.text });
          }
          break;
      }
    });

    function renderResults(results) {
      resultsContainer.innerHTML = '';
      if (results.length === 0) {
        if (searchInput.value.trim()) {
          resultsContainer.innerHTML = '<div class="no-results">No components match these classes</div>';
        } else {
          resultsContainer.innerHTML = '<div class="no-results">Type or paste classes to search</div>';
        }
        return;
      }

      results.forEach((res) => {
        const item = document.createElement('div');
        item.className = 'result-item';

        const header = document.createElement('div');
        header.className = 'result-header';

        const name = document.createElement('div');
        name.className = 'file-name';
        name.innerHTML = \`📄 \${res.fileName}\`;

        const percent = document.createElement('div');
        percent.className = 'match-percent';
        if (res.matchType === 'text') {
          // No class overlap, so a "% match" would be misleading.
          percent.classList.add('text-match');
          percent.textContent = 'text match';
        } else {
          const label = document.createElement('span');
          label.textContent = \`\${Math.round(res.score * 100)}% match\`;
          percent.appendChild(label);
          if (res.matchType === 'both') {
            // Also matched literally as text.
            const tag = document.createElement('span');
            tag.className = 'match-tag';
            tag.textContent = 'text';
            percent.appendChild(tag);
          }
        }

        const copyPathBtn = document.createElement('button');
        copyPathBtn.className = 'copy-btn';
        copyPathBtn.title = 'Copy file path';
        copyPathBtn.textContent = '⧉';
        copyPathBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'copy', text: res.file });
        });

        header.appendChild(name);
        header.appendChild(percent);
        header.appendChild(copyPathBtn);

        const path = document.createElement('div');
        path.className = 'file-path';
        path.textContent = res.relativePath;

        item.appendChild(header);
        item.appendChild(path);

        if (res.matchType !== 'text' && res.matchedClasses && res.matchedClasses.length > 0) {
          const matchedContainer = document.createElement('div');
          matchedContainer.className = 'matched-list';

          const matchedLabel = document.createElement('span');
          matchedLabel.className = 'matched-label';
          matchedLabel.textContent = 'Matched: ';
          matchedContainer.appendChild(matchedLabel);

          res.matchedClasses.forEach((cls) => {
            const badge = document.createElement('span');
            badge.className = 'matched-class';
            badge.textContent = cls;
            matchedContainer.appendChild(badge);
          });
          item.appendChild(matchedContainer);
        }

        if (res.nearMatches && res.nearMatches.length > 0) {
          const nearContainer = document.createElement('div');
          nearContainer.className = 'near-match-list';

          const nearLabel = document.createElement('span');
          nearLabel.className = 'near-match-label';
          nearLabel.textContent = 'Close: ';
          nearContainer.appendChild(nearLabel);

          res.nearMatches.forEach((nm) => {
            const badge = document.createElement('span');
            badge.className = 'near-match-class';
            badge.textContent = \`\${nm.input} ≈ \${nm.actual}\`;
            nearContainer.appendChild(badge);
          });
          item.appendChild(nearContainer);
        }

        if (res.unmatchedClasses && res.unmatchedClasses.length > 0) {
          const unmatchedContainer = document.createElement('div');
          unmatchedContainer.className = 'unmatched-list';
          
          const label = document.createElement('span');
          label.className = 'unmatched-label';
          label.textContent = 'Missing: ';
          unmatchedContainer.appendChild(label);

          res.unmatchedClasses.forEach((cls) => {
            const badge = document.createElement('span');
            badge.className = 'unmatched-class';
            badge.textContent = cls;
            unmatchedContainer.appendChild(badge);
          });
          item.appendChild(unmatchedContainer);
        }

        item.addEventListener('click', (e) => {
          if (e.target.closest('.location-item')) return;
          vscode.postMessage({ type: 'open', result: res, locationIndex: 0 });
        });

        item.addEventListener('mouseenter', (e) => {
          if (e.target.closest('.location-item')) return;
          if (hoverPreviewToggle.checked) {
            vscode.postMessage({ type: 'preview', result: res, locationIndex: 0 });
          }
        });

        if (res.locations && res.locations.length > 1) {
          const locsList = document.createElement('div');
          locsList.className = 'locations-list';

          const seenLines = new Set();
          const dedupedLocations = res.locations.filter(loc => {
            if (seenLines.has(loc.line)) return false;
            seenLines.add(loc.line);
            return true;
          });

          if (dedupedLocations.length > 1) {
            dedupedLocations.forEach((loc) => {
              const idx = res.locations.indexOf(loc);
              const locItem = document.createElement('div');
              locItem.className = 'location-item';

              const lineNum = document.createElement('span');
              lineNum.className = 'location-line';
              lineNum.textContent = \`Line \${loc.line + 1}:\`;

              const snippet = document.createElement('span');
              snippet.className = 'location-snippet';
              snippet.textContent = loc.context.trim();

              locItem.appendChild(lineNum);
              locItem.appendChild(snippet);

              locItem.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'open', result: res, locationIndex: idx });
              });

              locItem.addEventListener('mouseenter', (e) => {
                e.stopPropagation();
                if (hoverPreviewToggle.checked) {
                  vscode.postMessage({ type: 'preview', result: res, locationIndex: idx });
                }
              });

              locsList.appendChild(locItem);
            });
            item.appendChild(locsList);
          }
        }

        resultsContainer.appendChild(item);
      });

      resultsContainer.addEventListener('mouseleave', () => {
        vscode.postMessage({ type: 'clearPreview' });
      });
    }

    function updateReplaceApplyBtn() {
      replaceApplyBtn.textContent = \`Apply (\${selectedReplaceKeys.size})\`;
      replaceApplyBtn.disabled = selectedReplaceKeys.size === 0;
    }

    function renderReplacePreview(target, replacement, occurrences) {
      currentReplaceTarget = target;
      currentReplaceReplacement = replacement;
      selectedReplaceKeys = new Set(occurrences.map((o) => o.key));

      resultsContainer.style.display = 'none';
      replacePreviewContainer.style.display = 'flex';
      replacePreviewTitle.textContent = \`Replace "\${target}" → "\${replacement || '(delete)'}"\`;
      replacePreviewList.innerHTML = '';

      if (occurrences.length === 0) {
        replacePreviewList.innerHTML = '<div class="no-results">No occurrences to replace.</div>';
        updateReplaceApplyBtn();
        return;
      }

      // Group by file, preserving first-seen order.
      const groups = [];
      const groupByFile = new Map();
      occurrences.forEach((o) => {
        let group = groupByFile.get(o.file);
        if (!group) {
          group = { fileName: o.fileName, relativePath: o.relativePath, occurrences: [] };
          groupByFile.set(o.file, group);
          groups.push(group);
        }
        group.occurrences.push(o);
      });

      groups.forEach((group) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'replace-file-group';

        const header = document.createElement('div');
        header.className = 'replace-file-header';

        const fileCheckbox = document.createElement('input');
        fileCheckbox.type = 'checkbox';

        const names = document.createElement('div');
        names.style.minWidth = '0';
        names.style.flexGrow = '1';

        const fileNameEl = document.createElement('div');
        fileNameEl.className = 'replace-file-name';
        fileNameEl.textContent = \`📄 \${group.fileName}\`;

        const filePathEl = document.createElement('div');
        filePathEl.className = 'replace-file-path';
        filePathEl.textContent = group.relativePath;

        names.appendChild(fileNameEl);
        names.appendChild(filePathEl);
        header.appendChild(fileCheckbox);
        header.appendChild(names);
        groupEl.appendChild(header);

        // Closures over each checkbox avoid building a CSS selector from occurrence text,
        // which can contain quotes/brackets.
        const rowCheckboxes = [];

        function refreshFileCheckbox() {
          const checkedCount = group.occurrences.filter((o) => selectedReplaceKeys.has(o.key)).length;
          fileCheckbox.checked = checkedCount === group.occurrences.length;
          fileCheckbox.indeterminate = checkedCount > 0 && checkedCount < group.occurrences.length;
        }

        group.occurrences.forEach((o) => {
          const row = document.createElement('div');
          row.className = 'replace-occurrence';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selectedReplaceKeys.has(o.key);

          const body = document.createElement('div');
          body.className = 'replace-occurrence-body';

          const snippet = document.createElement('span');
          snippet.className = 'replace-occurrence-snippet';

          const lineLabel = document.createElement('span');
          lineLabel.className = 'replace-occurrence-line';
          lineLabel.textContent = \`L\${o.line + 1}\`;

          const beforeSpan = document.createElement('span');
          beforeSpan.className = 'replace-before';
          beforeSpan.textContent = o.before;

          const arrow = document.createElement('span');
          arrow.className = 'replace-arrow';
          arrow.textContent = '→';

          const afterSpan = document.createElement('span');
          afterSpan.className = 'replace-after';
          afterSpan.textContent = o.after || '(removed)';

          snippet.appendChild(lineLabel);
          snippet.appendChild(beforeSpan);
          snippet.appendChild(arrow);
          snippet.appendChild(afterSpan);
          body.appendChild(snippet);

          row.appendChild(checkbox);
          row.appendChild(body);

          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              selectedReplaceKeys.add(o.key);
            } else {
              selectedReplaceKeys.delete(o.key);
            }
            refreshFileCheckbox();
            updateReplaceApplyBtn();
          });

          row.addEventListener('click', (e) => {
            if (e.target === checkbox) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          });

          rowCheckboxes.push(checkbox);
          groupEl.appendChild(row);
        });

        fileCheckbox.addEventListener('change', () => {
          const shouldSelect = fileCheckbox.checked;
          group.occurrences.forEach((o, i) => {
            if (shouldSelect) {
              selectedReplaceKeys.add(o.key);
            } else {
              selectedReplaceKeys.delete(o.key);
            }
            rowCheckboxes[i].checked = shouldSelect;
          });
          updateReplaceApplyBtn();
        });

        header.addEventListener('click', (e) => {
          if (e.target === fileCheckbox) return;
          fileCheckbox.checked = !fileCheckbox.checked;
          fileCheckbox.dispatchEvent(new Event('change'));
        });

        refreshFileCheckbox();
        replacePreviewList.appendChild(groupEl);
      });

      updateReplaceApplyBtn();
    }
  </script>
</body>
</html>
`;
  }
}
