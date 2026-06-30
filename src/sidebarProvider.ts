import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceIndexer } from "./indexer";
import { parsePastedClassList, extractClassesFromPaste, isStyleInput, parsePastedStyleList } from "./classParser";
import { rankFiles } from "./matcher";
import { openAndHighlight, clearDecorations } from "./quickPick";
import type { SearchResult } from "./types";

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
          const textSearchEnabled = data.textSearchEnabled !== false;
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
            rawInput: textSearchEnabled ? rawInput : undefined
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
              matchedCount: r.matchedCount,
              totalInputCount: r.totalInputCount,
              matchedClasses: r.matchedClasses,
              unmatchedClasses: r.unmatchedClasses,
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

    .no-results {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground, #858585);
    }
  </style>
</head>
<body>
  <div class="search-container">
    <div class="input-wrapper">
      <input type="text" id="search-input" placeholder="Paste class list or HTML element..." autocomplete="off">
      <button class="clear-btn" id="clear-btn" title="Clear input">×</button>
    </div>
    <div class="toggle-container">
      <label class="toggle-label">
        <input type="checkbox" id="text-search-toggle" checked>
        <span>Include general text search</span>
      </label>
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

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-btn');
    const statusText = document.getElementById('status-text');
    const resultsContainer = document.getElementById('results-container');
    const textSearchToggle = document.getElementById('text-search-toggle');
    const hoverPreviewToggle = document.getElementById('hover-preview-toggle');

    let currentFileCount = 0;

    vscode.postMessage({ type: 'readClipboard' });

    textSearchToggle.addEventListener('change', () => {
      vscode.postMessage({
        type: 'search',
        value: searchInput.value,
        textSearchEnabled: textSearchToggle.checked
      });
    });

    hoverPreviewToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'togglePreview', enabled: hoverPreviewToggle.checked });
    });

    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      clearBtn.style.display = val ? 'flex' : 'none';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({
          type: 'search',
          value: val,
          textSearchEnabled: textSearchToggle.checked
        });
      }, 100);
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      searchInput.focus();
      vscode.postMessage({
        type: 'search',
        value: '',
        textSearchEnabled: textSearchToggle.checked
      });
      vscode.postMessage({ type: 'clearPreview' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'results':
          renderResults(message.results);
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
            vscode.postMessage({
              type: 'search',
              value: message.text,
              textSearchEnabled: textSearchToggle.checked
            });
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
        percent.textContent = \`\${Math.round(res.score * 100)}% match\`;

        header.appendChild(name);
        header.appendChild(percent);

        const path = document.createElement('div');
        path.className = 'file-path';
        path.textContent = res.relativePath;

        item.appendChild(header);
        item.appendChild(path);

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
  </script>
</body>
</html>
`;
  }
}
