import * as path from "path";
import * as vscode from "vscode";
import type { SearchResult } from "./types";

const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  borderRadius: "2px",
});

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

const COPY_PATH_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("copy"),
  tooltip: "Copy file path",
};

const COPY_CLASSES_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("symbol-string"),
  tooltip: "Copy matched classes",
};

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

interface FileItem extends vscode.QuickPickItem {
  itemType: "file";
  result: SearchResult;
  locationIndex: number;
}

interface LocationItem extends vscode.QuickPickItem {
  itemType: "location";
  result: SearchResult;
  locationIndex: number;
}

type Item = FileItem | LocationItem;

function buildItems(result: SearchResult, workspaceRoot: string | undefined): Item[] {
  const relativePath = workspaceRoot
    ? path.relative(workspaceRoot, result.file)
    : result.file;

  const isTextOnly = result.matchType === "text";

  const matchedPreview = result.matchedClasses.slice(0, 8).join(" ");
  const overflow = result.matchedClasses.length > 8 ? " …" : "";

  const detailParts = [
    isTextOnly
      ? `${relativePath}  —  text match`
      : `${relativePath}  —  ${matchedPreview}${overflow}`,
  ];
  if (result.nearMatches.length > 0) {
    const nearPreview = result.nearMatches
      .slice(0, 4)
      .map((nm) => `${nm.input}≈${nm.actual}`)
      .join(", ");
    detailParts.push(`close: ${nearPreview}`);
  }
  if (result.unmatchedClasses.length > 0) {
    const missingPreview = result.unmatchedClasses.slice(0, 4).join(" ");
    const missingOverflow = result.unmatchedClasses.length > 4 ? " …" : "";
    detailParts.push(`missing: ${missingPreview}${missingOverflow}`);
  }

  const seenLines = new Set<number>();
  const dedupedLocations = result.locations.filter((loc) => {
    if (seenLines.has(loc.line)) return false;
    seenLines.add(loc.line);
    return true;
  });

  const description = isTextOnly
    ? "$(search) text match"
    : `${formatPercent(result.score)} match  (${result.matchedCount}/${result.totalInputCount})${
        result.matchType === "both" ? "  $(search) +text" : ""
      }`;

  const fileItem: FileItem = {
    itemType: "file",
    result,
    locationIndex: 0,
    label: `$(file-code) ${path.basename(result.file)}`,
    description,
    detail: detailParts.join("   |   "),
    buttons: [COPY_PATH_BUTTON, COPY_CLASSES_BUTTON],
  };

  if (dedupedLocations.length <= 1) {
    return [fileItem];
  }

  const locationItems: LocationItem[] = dedupedLocations.map((loc, i) => ({
    itemType: "location",
    result,
    locationIndex: result.locations.indexOf(loc),
    label: `    $(symbol-keyword) Line ${loc.line + 1}`,
    description: ``,
    detail: `    ${loc.context.slice(0, 100)}`,
  }));

  return [fileItem, ...locationItems];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function showResultsQuickPick(results: SearchResult[]): Promise<void> {
  if (results.length === 0) {
    vscode.window.showInformationMessage(
      "Smart Class Search: no files matched any of the pasted classes."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items: Item[] = results.flatMap((r) => buildItems(r, workspaceRoot));

  const originalEditor = vscode.window.activeTextEditor;
  let previewEditor: vscode.TextEditor | undefined;

  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.title = `Smart Class Search — ${results.length} match${results.length === 1 ? "" : "es"}`;
  qp.placeholder = "Select a result to open it at the matching line";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const subs: vscode.Disposable[] = [];

  const cfg = vscode.workspace.getConfiguration("smartClassLookup");
  const enablePreview = cfg.get<boolean>("enablePreview", true);

  if (enablePreview) {
    subs.push(
      qp.onDidChangeActive(async (activeItems) => {
        const active = activeItems[0];
        if (!active) return;
        previewEditor = await openAndHighlight(active.result, active.locationIndex, true);
      })
    );
  }

  subs.push(
    qp.onDidTriggerItemButton(async (e) => {
      const item = e.item as Item;
      if (e.button === COPY_PATH_BUTTON) {
        await vscode.env.clipboard.writeText(item.result.file);
        vscode.window.setStatusBarMessage("$(check) Copied file path", 2000);
      } else if (e.button === COPY_CLASSES_BUTTON) {
        await vscode.env.clipboard.writeText(item.result.matchedClasses.join(" "));
        vscode.window.setStatusBarMessage("$(check) Copied matched classes", 2000);
      }
    })
  );

  const picked = await new Promise<Item | undefined>((resolve) => {
    subs.push(
      qp.onDidAccept(() => resolve(qp.activeItems[0])),
      qp.onDidHide(() => resolve(undefined))
    );
    qp.show();
  });

  qp.dispose();
  for (const s of subs) s.dispose();

  if (!picked) {
    clearDecorations(previewEditor);
    if (originalEditor) {
      await vscode.window.showTextDocument(originalEditor.document, {
        viewColumn: originalEditor.viewColumn,
        selection: originalEditor.selection,
        preview: false,
      });
    }
    return;
  }

  await openAndHighlight(picked.result, picked.locationIndex, false);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clearDecorations(editor: vscode.TextEditor | undefined): void {
  editor?.setDecorations(highlightDecorationType, []);
}

export async function openAndHighlight(
  result: SearchResult,
  locationIndex: number,
  preview: boolean
): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(result.file);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview });

  const targetLoc = result.locations[locationIndex] ?? result.locations[0];
  if (!targetLoc) return editor;

  const targetPosition = new vscode.Position(targetLoc.line, targetLoc.column);
  editor.selection = new vscode.Selection(targetPosition, targetPosition);
  editor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenter
  );

  const seenLines = new Set<number>();
  const ranges = result.locations
    .filter((loc) => {
      if (seenLines.has(loc.line)) return false;
      seenLines.add(loc.line);
      return true;
    })
    .map((loc) => {
      const lineLength = document.lineAt(loc.line).text.length;
      return new vscode.Range(loc.line, 0, loc.line, lineLength);
    });

  editor.setDecorations(highlightDecorationType, ranges);

  if (!preview) {
    const clear = () => editor.setDecorations(highlightDecorationType, []);
    const timeout = setTimeout(clear, 4000);
    const sub = vscode.window.onDidChangeActiveTextEditor(() => {
      clearTimeout(timeout);
      clear();
      sub.dispose();
    });
  }

  return editor;
}
