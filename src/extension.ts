import * as path from "path";
import * as vscode from "vscode";
import { applyReplace, clipboardQuery, previewReplace, reportReplace, searchIndex } from "./actions";
import { findDuplicateClassGroups } from "./duplicates";
import { displayPath, revealLocations } from "./editor";
import { WorkspaceIndexer } from "./indexer";
import { parseQuery, parseReplace, queryFromPaste } from "./query";
import { showResultsQuickPick } from "./quickPick";
import { settings } from "./settings";
import { SidebarProvider } from "./sidebarProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Smart Class Search");
  const indexer = new WorkspaceIndexer(output, context);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  const sidebar = new SidebarProvider(context.extensionUri, indexer);

  const updateStatusBar = () => {
    statusBarItem.text = indexer.isBuilding
      ? "$(sync~spin) Smart Class Search: indexing…"
      : `$(search) Smart Class Search (${indexer.fileCount} files)`;
  };
  statusBarItem.command = "smartClassLookup.search";
  statusBarItem.tooltip = "Click to run Smart Class Search";
  updateStatusBar();
  statusBarItem.show();

  context.subscriptions.push(
    output,
    indexer,
    statusBarItem,
    indexer.onDidUpdate(updateStatusBar),
    sidebar,
    vscode.window.registerWebviewViewProvider("smartClassLookup.sidebarView", sidebar),
    vscode.commands.registerCommand("smartClassLookup.search", () => runSearchCommand(indexer)),
    vscode.commands.registerCommand("smartClassLookup.replace", () => runReplaceCommand(indexer)),
    vscode.commands.registerCommand("smartClassLookup.findDuplicates", () => runFindDuplicatesCommand(indexer)),
    vscode.commands.registerCommand("smartClassLookup.rebuildIndex", () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Smart Class Search: rebuilding index..." },
        () => indexer.buildFullIndex()
      )
    )
  );

  void indexer.start();
}

function selectedText(): string {
  const editor = vscode.window.activeTextEditor;
  return editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : "";
}

async function runFindDuplicatesCommand(indexer: WorkspaceIndexer): Promise<void> {
  const minClasses = settings().duplicateMinClasses;

  const groups = findDuplicateClassGroups(indexer.getIndex(), minClasses);
  if (groups.length === 0) {
    vscode.window.showInformationMessage(
      `Smart Class Search: no duplicate class combinations found (min ${minClasses} classes, 2+ files).`
    );
    return;
  }

  const groupPick = await vscode.window.showQuickPick(
    groups.map((g) => {
      const files = [...new Set(g.occurrences.map((o) => o.file))];
      return {
        label: `$(files) ${files.length} files share ${g.classes.length} classes`,
        description: g.classes.slice(0, 6).join(" ") + (g.classes.length > 6 ? " …" : ""),
        detail: files.map(displayPath).join(", "),
        group: g,
      };
    }),
    {
      title: `Smart Class Search — ${groups.length} duplicate class combination${groups.length === 1 ? "" : "s"}`,
      placeHolder: "Select a duplicated class combination to see where it's used",
    }
  );
  if (!groupPick) return;

  const occurrencePick = await vscode.window.showQuickPick(
    groupPick.group.occurrences.map((o) => ({
      label: `$(file-code) ${path.basename(o.file)}:${o.line + 1}`,
      description: displayPath(o.file),
      detail: o.context,
      occurrence: o,
    })),
    { title: "Occurrences of this class combination", placeHolder: "Select one to open it" }
  );
  if (!occurrencePick) return;

  const { file, line } = occurrencePick.occurrence;
  await revealLocations(file, [{ line, column: 0 }], 0, false);
}

async function runSearchCommand(indexer: WorkspaceIndexer): Promise<void> {
  const selected = selectedText();
  const prefill = selected ? queryFromPaste(selected) : (await clipboardQuery()) ?? "";

  const raw = await vscode.window.showInputBox({
    title: "Smart Class Search",
    prompt: prefill
      ? selected
        ? "Selection detected — press Enter to search, or replace with your input"
        : "Clipboard detected — press Enter to search, or replace with your input"
      : "Paste class list or DevTools style (e.g. style=\"...\")",
    placeHolder: "relative px-5 OR min-height: 100vh; font-size: 13px;",
    value: prefill,
    valueSelection: prefill ? [0, prefill.length] : undefined,
    ignoreFocusOut: true,
  });
  if (!raw?.trim()) return;

  const query = parseQuery(raw);
  if (query.isStyle && query.classes.length === 0) {
    vscode.window.showWarningMessage("Smart Class Search: no style properties were found in that input.");
    return;
  }

  await showResultsQuickPick(searchIndex(indexer.getIndex(), query));
}

async function runReplaceCommand(indexer: WorkspaceIndexer): Promise<void> {
  const rawFind = await vscode.window.showInputBox({
    title: "Smart Class Replace: Find",
    prompt: "Enter class(es) to find",
    placeHolder: "e.g. bg-red-500",
    value: selectedText() || (await clipboardQuery()),
    ignoreFocusOut: true,
  });
  if (!rawFind?.trim()) return;

  const rawReplace = await vscode.window.showInputBox({
    title: "Smart Class Replace: Replace",
    prompt: "Enter replacement class(es) (leave empty to delete)",
    placeHolder: "e.g. bg-blue-500",
    value: rawFind,
    ignoreFocusOut: true,
  });
  if (rawReplace === undefined) return;

  const spec = parseReplace(rawFind, rawReplace);
  const occurrences = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Smart Class Search: Analyzing files..." },
    () => previewReplace(indexer.getIndex(), spec)
  );
  if (occurrences.length === 0) {
    vscode.window.showInformationMessage("Smart Class Replace: No matching class occurrences found.");
    return;
  }

  const fileCount = new Set(occurrences.map((o) => o.file)).size;
  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to replace '${rawFind}' with '${rawReplace}' in ${fileCount} file(s) (${occurrences.length} occurrence(s))?`,
    { modal: true },
    "Replace"
  );
  if (confirm !== "Replace") return;

  reportReplace(await applyReplace(indexer.getIndex(), spec, new Set(occurrences.map((o) => o.key))));
}
