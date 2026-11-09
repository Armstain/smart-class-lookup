import * as path from "path";
import * as vscode from "vscode";
import type { ClassLocation } from "./types";

const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  border: "1px solid",
  borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
  borderRadius: "2px",
});

export function displayPath(file: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.relative(root, file) : file;
}

export function clearHighlight(editor: vscode.TextEditor | undefined): void {
  editor?.setDecorations(highlightDecorationType, []);
}

export function uniqueLines(locations: ClassLocation[]): ClassLocation[] {
  const seen = new Set<number>();
  return locations.filter((loc) => {
    if (seen.has(loc.line)) return false;
    seen.add(loc.line);
    return true;
  });
}

export async function revealLocations(
  file: string,
  locations: Pick<ClassLocation, "line" | "column">[],
  target: number,
  preview: boolean
): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document, { preview, preserveFocus: preview });

  const targetLoc = locations[target] ?? locations[0];
  if (!targetLoc) return editor;

  const targetPosition = new vscode.Position(targetLoc.line, targetLoc.column);
  editor.selection = new vscode.Selection(targetPosition, targetPosition);
  editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);

  const lines = [...new Set(locations.map((loc) => loc.line))];
  editor.setDecorations(
    highlightDecorationType,
    lines.map((line) => new vscode.Range(line, 0, line, document.lineAt(line).text.length))
  );

  if (!preview) {
    const timeout = setTimeout(() => clearHighlight(editor), 4000);
    const sub = vscode.window.onDidChangeActiveTextEditor(() => {
      clearTimeout(timeout);
      clearHighlight(editor);
      sub.dispose();
    });
  }

  return editor;
}
