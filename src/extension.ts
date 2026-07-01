import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceIndexer } from "./indexer";
import { parsePastedClassList, extractClassesFromPaste, isStyleInput, parsePastedStyleList } from "./classParser";
import { rankFiles } from "./matcher";
import { openAndHighlight, showResultsQuickPick } from "./quickPick";
import { SidebarProvider } from "./sidebarProvider";
import { findDuplicateClassGroups } from "./duplicates";
import type { SearchResult } from "./types";

let indexer: WorkspaceIndexer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Smart Class Lookup");
  context.subscriptions.push(output);

  indexer = new WorkspaceIndexer(output, context);
  context.subscriptions.push(indexer);

  const sidebarProvider = new SidebarProvider(context.extensionUri, indexer);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("smartClassLookup.sidebarView", sidebarProvider)
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "smartClassLookup.search";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    indexer.onDidUpdate(() => updateStatusBar())
  );

  void indexer.buildFullIndex().then(() => indexer?.startWatching());
  updateStatusBar(true);
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("smartClassLookup.search", runSearchCommand),
    vscode.commands.registerCommand("smartClassLookup.rebuildIndex", async () => {
      if (!indexer) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Smart Class Lookup: rebuilding index..." },
        () => indexer!.buildFullIndex()
      );
      void indexer.startWatching();
    }),
    vscode.commands.registerCommand("smartClassLookup.findDuplicates", runFindDuplicatesCommand)
  );
}

async function runFindDuplicatesCommand(): Promise<void> {
  if (!indexer) return;

  const cfg = vscode.workspace.getConfiguration("smartClassLookup");
  const minClasses = cfg.get<number>("duplicateMinClasses", 3);

  const groups = findDuplicateClassGroups(indexer.getIndex(), minClasses);
  if (groups.length === 0) {
    vscode.window.showInformationMessage(
      `Smart Class Lookup: no duplicate class combinations found (min ${minClasses} classes, 2+ files).`
    );
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const groupPick = await vscode.window.showQuickPick(
    groups.map((g) => ({
      label: `$(files) ${new Set(g.occurrences.map((o) => o.file)).size} files share ${g.classes.length} classes`,
      description: g.classes.slice(0, 6).join(" ") + (g.classes.length > 6 ? " …" : ""),
      detail: [...new Set(g.occurrences.map((o) => o.file))]
        .map((f) => (workspaceRoot ? path.relative(workspaceRoot, f) : f))
        .join(", "),
      group: g,
    })),
    {
      title: `Smart Class Lookup — ${groups.length} duplicate class combination${groups.length === 1 ? "" : "s"}`,
      placeHolder: "Select a duplicated class combination to see where it's used",
    }
  );

  if (!groupPick) return;

  const occurrencePick = await vscode.window.showQuickPick(
    groupPick.group.occurrences.map((o) => ({
      label: `$(file-code) ${path.basename(o.file)}:${o.line + 1}`,
      description: workspaceRoot ? path.relative(workspaceRoot, o.file) : o.file,
      detail: o.context,
      occurrence: o,
    })),
    { title: "Occurrences of this class combination", placeHolder: "Select one to open it" }
  );

  if (!occurrencePick) return;

  const { file, line, context } = occurrencePick.occurrence;
  const syntheticResult: SearchResult = {
    file,
    matchedCount: groupPick.group.classes.length,
    totalInputCount: groupPick.group.classes.length,
    score: 1,
    matchedClasses: groupPick.group.classes,
    unmatchedClasses: [],
    nearMatches: [],
    locations: [{ file, line, column: 0, context }],
    maxLineMatches: groupPick.group.classes.length,
  };
  await openAndHighlight(syntheticResult, 0, false);
}

function updateStatusBar(building = false): void {
  if (!statusBarItem || !indexer) return;
  statusBarItem.text = building
    ? "$(sync~spin) Smart Class Lookup: indexing…"
    : `$(search) Smart Class Lookup (${indexer.fileCount} files)`;
  statusBarItem.tooltip = "Click to run Smart Class Lookup";
}

function looksLikeClassInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\bclass(?:Name)?\s*=/i.test(trimmed)) return true;
  if (/[{};()=<>]/.test(trimmed)) return false;
  return /^[a-zA-Z0-9!\-:[\]_./\s]+$/.test(trimmed) && trimmed.split(/\s+/).length >= 2;
}

async function runSearchCommand(): Promise<void> {
  if (!indexer) return;

  let prefill = "";
  try {
    const clip = await vscode.env.clipboard.readText();
    if (looksLikeClassInput(clip) || isStyleInput(clip)) {
      prefill = isStyleInput(clip) ? clip.trim() : extractClassesFromPaste(clip);
    }
  } catch {
  }

  const raw = await vscode.window.showInputBox({
    title: "Smart Class Lookup",
    prompt: prefill
      ? "Clipboard detected — press Enter to search, or replace with your input"
      : "Paste class list or DevTools style (e.g. style=\"...\")",
    placeHolder: "relative px-5 OR min-height: 100vh; font-size: 13px;",
    value: prefill,
    valueSelection: prefill ? [0, prefill.length] : undefined,
    ignoreFocusOut: true,
  });

  if (raw === undefined || raw.trim().length === 0) {
    return;
  }

  const isStyle = isStyleInput(raw);
  const inputClasses = isStyle ? parsePastedStyleList(raw) : parsePastedClassList(raw);
  if (inputClasses.length === 0) {
    vscode.window.showWarningMessage(
      isStyle
        ? "Smart Class Lookup: no style properties were found in that input."
        : "Smart Class Lookup: no class names were found in that input."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("smartClassLookup");
  const minScore = cfg.get<number>("minScore", 0.15);
  const maxResults = cfg.get<number>("maxResults", 25);

  const results = rankFiles(inputClasses, indexer.getIndex(), { minScore, maxResults });
  await showResultsQuickPick(results);
}

export function deactivate(): void {
  indexer?.dispose();
  indexer = undefined;
}

