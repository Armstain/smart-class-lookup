export interface SidebarState {
  fileCount: number;
  building: boolean;
  enablePreview: boolean;
}

export function sidebarHtml(state: SidebarState): string {
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
      margin-top: 4px;
    }

    .replace-btn {
      position: absolute;
      top: 50%;
      right: 6px;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: none;
      color: var(--vscode-icon-foreground, #cccccc);
      border: none;
      padding: 0;
      border-radius: 3px;
      cursor: pointer;
    }

    .replace-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
      flex-shrink: 0;
    }

    .replace-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
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

    .match-highlight {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
      border-radius: 2px;
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
      <button class="replace-btn" id="replace-btn" title="Preview occurrences before replacing"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99zM21 9l-3.99-4v3H10v2h7.01v3z"/></svg></button>
    </div>
    <div class="toggle-container">
      <label class="toggle-label">
        <input type="checkbox" id="hover-preview-toggle" ${state.enablePreview ? "checked" : ""}>
        <span>Live preview on hover</span>
      </label>
    </div>
    <div class="status-text" id="status-text"></div>
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

    let indexing = false;

    function renderStatus(fileCount, building) {
      indexing = building;
      statusText.textContent = building ? 'Indexing files…' : \`Index contains \${fileCount} files\`;
    }
    renderStatus(${state.fileCount}, ${state.building});
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
      if (replacePreviewContainer.style.display === 'none') return;
      replacePreviewContainer.style.display = 'none';
      resultsContainer.style.display = '';
      vscode.postMessage({ type: 'clearPreview' });
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

    vscode.postMessage({ type: 'ready' });

    hoverPreviewToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'togglePreview', enabled: hoverPreviewToggle.checked });
    });

    function search(value) {
      vscode.postMessage({ type: 'search', value });
    }

    function setQuery(value) {
      searchInput.value = value;
      clearBtn.style.display = value ? 'flex' : 'none';
    }

    function previewIfEnabled(message) {
      if (hoverPreviewToggle.checked) vscode.postMessage(message);
    }

    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      // Search box doubles as the replace "find" field — an open preview is now stale.
      closeReplacePreview();
      const val = e.target.value;
      setQuery(val);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => search(val), 100);
    });

    replaceInput.addEventListener('input', closeReplacePreview);

    clearBtn.addEventListener('click', () => {
      closeReplacePreview();
      setQuery('');
      searchInput.focus();
      search('');
    });

    resultsContainer.addEventListener('mouseleave', () => vscode.postMessage({ type: 'clearPreview' }));
    replacePreviewList.addEventListener('mouseleave', () => vscode.postMessage({ type: 'clearPreview' }));

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'results':
          queryTerms = message.terms;
          renderResults(message.results);
          break;
        case 'resultsUpdated':
          closeReplacePreview();
          search(searchInput.value);
          break;
        case 'replacePreview':
          renderReplacePreview(message.target, message.replacement, message.occurrences);
          break;
        case 'state':
          renderStatus(message.fileCount, message.building);
          hoverPreviewToggle.checked = message.enablePreview;
          if (message.indexChanged && searchInput.value.trim()) search(searchInput.value);
          break;
        case 'clipboardText':
          if (!searchInput.value.trim()) {
            setQuery(message.text);
            search(message.text);
          }
          break;
      }
    });

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    let queryTerms = [];

    function findMatchRanges(text, terms) {
      const lowerText = text.toLowerCase();
      const ranges = [];
      terms.forEach((term) => {
        if (!term) return;
        let from = 0;
        let idx = lowerText.indexOf(term, from);
        while (idx !== -1) {
          ranges.push([idx, idx + term.length]);
          from = idx + term.length;
          idx = lowerText.indexOf(term, from);
        }
      });
      ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const merged = [];
      ranges.forEach((range) => {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) {
          last[1] = Math.max(last[1], range[1]);
        } else {
          merged.push(range);
        }
      });
      return merged;
    }

    function highlightMatches(text, query) {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) return escapeHtml(text);

      let terms = [trimmedQuery.toLowerCase()];
      if (text.toLowerCase().indexOf(terms[0]) === -1) {
        terms = queryTerms;
      }
      if (terms.length === 0) return escapeHtml(text);

      const ranges = findMatchRanges(text, terms);
      if (ranges.length === 0) return escapeHtml(text);

      let html = '';
      let cursor = 0;
      ranges.forEach((range) => {
        html += escapeHtml(text.slice(cursor, range[0]));
        html += '<span class="match-highlight">' + escapeHtml(text.slice(range[0], range[1])) + '</span>';
        cursor = range[1];
      });
      html += escapeHtml(text.slice(cursor));
      return html;
    }

    function renderResults(results) {
      resultsContainer.innerHTML = '';
      if (results.length === 0) {
        if (searchInput.value.trim()) {
          resultsContainer.innerHTML = indexing
            ? '<div class="no-results">Still indexing, results may be incomplete</div>'
            : '<div class="no-results">No components match these classes</div>';
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
        name.textContent = \`📄 \${res.fileName}\`;

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

        if (res.matchType !== 'text') {
          appendBadgeList(item, 'matched', 'Matched: ', res.matchedClasses);
        }
        appendBadgeList(item, 'near-match', 'Close: ', res.nearMatches.map((nm) => \`\${nm.input} ≈ \${nm.actual}\`));
        appendBadgeList(item, 'unmatched', 'Missing: ', res.unmatchedClasses);

        const target = { file: res.file, locations: res.locations };
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', result: target, locationIndex: 0 });
        });
        item.addEventListener('mouseenter', () => {
          previewIfEnabled({ type: 'preview', result: target, locationIndex: 0 });
        });

        const isTextMatch = res.matchType === 'text' || res.matchType === 'both';

        if (res.locations.length > 0) {
          const locsList = document.createElement('div');
          locsList.className = 'locations-list';

          res.locations.forEach((loc, idx) => {
            const locItem = document.createElement('div');
            locItem.className = 'location-item';

            const lineNum = document.createElement('span');
            lineNum.className = 'location-line';
            lineNum.textContent = \`Line \${loc.line + 1}:\`;

            const snippet = document.createElement('span');
            snippet.className = 'location-snippet';
            if (isTextMatch) {
              snippet.innerHTML = highlightMatches(loc.context.trim(), searchInput.value);
            } else {
              snippet.textContent = loc.context.trim();
            }

            locItem.appendChild(lineNum);
            locItem.appendChild(snippet);

            locItem.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'open', result: target, locationIndex: idx });
            });
            locItem.addEventListener('mouseenter', () => {
              previewIfEnabled({ type: 'preview', result: target, locationIndex: idx });
            });

            locsList.appendChild(locItem);
          });
          item.appendChild(locsList);
        }

        resultsContainer.appendChild(item);
      });
    }

    function appendBadgeList(parent, kind, labelText, items) {
      if (items.length === 0) return;
      const list = document.createElement('div');
      list.className = kind + '-list';
      const label = document.createElement('span');
      label.className = kind + '-label';
      label.textContent = labelText;
      list.appendChild(label);
      items.forEach((text) => {
        const badge = document.createElement('span');
        badge.className = kind + '-class';
        badge.textContent = text;
        list.appendChild(badge);
      });
      parent.appendChild(list);
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
            vscode.postMessage({ type: 'openOccurrence', file: o.file, line: o.line });
          });
          row.addEventListener('mouseenter', () => {
            previewIfEnabled({ type: 'previewOccurrence', file: o.file, line: o.line });
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

        const first = group.occurrences[0];
        header.addEventListener('click', (e) => {
          if (e.target === fileCheckbox) return;
          vscode.postMessage({ type: 'openOccurrence', file: first.file, line: first.line });
        });
        header.addEventListener('mouseenter', () => {
          previewIfEnabled({ type: 'previewOccurrence', file: first.file, line: first.line });
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
