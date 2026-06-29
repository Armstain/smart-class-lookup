/**
 * Renders search results in a Quick Pick, and handles jumping to + briefly
 * highlighting the matched classes when the user picks a result.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { SearchResult } from "./types";

interface ResultQuickPickItem extends vscode.QuickPickItem {
  result: SearchResult;
}

const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  borderRadius: "2px",
});

function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function buildItem(result: SearchResult, workspaceRoot: string | undefined): ResultQuickPickItem {
  const relativePath = workspaceRoot
    ? path.relative(workspaceRoot, result.file)
    : result.file;

  const matchedPreview = result.matchedClasses.slice(0, 8).join(" ");
  const overflow = result.matchedClasses.length > 8 ? " …" : "";

  return {
    result,
    label: `$(file-code) ${path.basename(result.file)}`,
    description: `${formatPercent(result.score)} match  (${result.matchedCount}/${result.totalInputCount})`,
    detail: `${relativePath}  —  ${matchedPreview}${overflow}`,
  };
}

/** Show the ranked results and, if the user picks one, open + highlight it. */
export async function showResultsQuickPick(results: SearchResult[]): Promise<void> {
  if (results.length === 0) {
    vscode.window.showInformationMessage(
      "Smart Class Lookup: no files matched any of the pasted classes."
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const items = results.map((r) => buildItem(r, workspaceRoot));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Smart Class Lookup — ${results.length} match${results.length === 1 ? "" : "es"}`,
    placeHolder: "Select a component to open it and jump to the matching classes",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;
  await openAndHighlight(picked.result);
}

async function openAndHighlight(result: SearchResult): Promise<void> {
  const uri = vscode.Uri.file(result.file);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  if (result.locations.length === 0) return;

  // Jump to the first matched location.
  const first = result.locations[0];
  const targetPosition = new vscode.Position(first.line, first.column);
  editor.selection = new vscode.Selection(targetPosition, targetPosition);
  editor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenter
  );

  // Highlight every matched location's containing line span briefly so the
  // user can see at a glance which classes matched.
  const ranges = result.locations.map((loc) => {
    const lineLength = document.lineAt(loc.line).text.length;
    return new vscode.Range(loc.line, 0, loc.line, lineLength);
  });
  editor.setDecorations(highlightDecorationType, ranges);

  // Clear the highlight after a few seconds, or as soon as the user moves on.
  const clear = () => editor.setDecorations(highlightDecorationType, []);
  const timeout = setTimeout(clear, 4000);
  const sub = vscode.window.onDidChangeActiveTextEditor(() => {
    clearTimeout(timeout);
    clear();
    sub.dispose();
  });
}
