/**
 * Renders search results in a Quick Pick, and handles jumping to + briefly
 * highlighting the matched classes when the user picks a result.
 *
 * UI behaviour:
 *  - Arrow-key navigation opens a live file preview and highlights matched
 *    lines in real time; dismissing without selection restores the original
 *    editor.
 *  - Results with matches on multiple distinct lines are expanded: each
 *    occurrence is shown as a separate item so the user can jump directly to
 *    the exact spot in one click.
 */

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

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

interface FileItem extends vscode.QuickPickItem {
  itemType: "file";
  result: SearchResult;
  /** The location index this item should jump to (first location by default). */
  locationIndex: number;
}

interface LocationItem extends vscode.QuickPickItem {
  itemType: "location";
  result: SearchResult;
  locationIndex: number;
}

type Item = FileItem | LocationItem;

/** Build the flat list of Quick Pick items for a single SearchResult. */
function buildItems(result: SearchResult, workspaceRoot: string | undefined): Item[] {
  const relativePath = workspaceRoot
    ? path.relative(workspaceRoot, result.file)
    : result.file;

  const matchedPreview = result.matchedClasses.slice(0, 8).join(" ");
  const overflow = result.matchedClasses.length > 8 ? " …" : "";

  // Deduplicate locations by line so we don't create 8 items for the same line.
  const seenLines = new Set<number>();
  const dedupedLocations = result.locations.filter((loc) => {
    if (seenLines.has(loc.line)) return false;
    seenLines.add(loc.line);
    return true;
  });

  const fileItem: FileItem = {
    itemType: "file",
    result,
    locationIndex: 0,
    label: `$(file-code) ${path.basename(result.file)}`,
    description: `${formatPercent(result.score)} match  (${result.matchedCount}/${result.totalInputCount})`,
    detail: `${relativePath}  —  ${matchedPreview}${overflow}`,
  };

  // If there's only one distinct match line, just show the file item.
  if (dedupedLocations.length <= 1) {
    return [fileItem];
  }

  // More than one distinct location: add a sub-item per line so the user can
  // pick the exact occurrence they want.
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

/** Show the ranked results and, if the user picks one, open + highlight it. */
export async function showResultsQuickPick(results: SearchResult[]): Promise<void> {
  if (results.length === 0) {
    vscode.window.showInformationMessage(
      "Smart Class Lookup: no files matched any of the pasted classes."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items: Item[] = results.flatMap((r) => buildItems(r, workspaceRoot));

  // Remember the editor the user was in before opening the Quick Pick, so we
  // can restore it if they dismiss without selecting.
  const originalEditor = vscode.window.activeTextEditor;
  let previewEditor: vscode.TextEditor | undefined;

  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.title = `Smart Class Lookup — ${results.length} match${results.length === 1 ? "" : "es"}`;
  qp.placeholder = "Select a result to open it at the matching line";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const subs: vscode.Disposable[] = [];

  // Live preview: open the file and highlight matches as the user arrows through.
  subs.push(
    qp.onDidChangeActive(async (activeItems) => {
      const active = activeItems[0];
      if (!active) return;
      previewEditor = await openAndHighlight(active.result, active.locationIndex, true);
    })
  );

  // Selection: open the file non-preview, leave highlights up, then clear after 4s.
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
    // User dismissed — restore the original editor.
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

  // Open the picked file non-preview and keep highlights for 4s.
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

  // Highlight every matched location's line so the user can see at a glance
  // which lines contain matched classes.
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
    // Clear the highlight after a few seconds, or as soon as the user moves on.
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
