/**
 * Extension entry point: registers commands, owns the workspace index, and
 * wires the input box -> matcher -> Quick Pick flow together.
 */

import * as vscode from "vscode";
import { WorkspaceIndexer } from "./indexer";
import { parsePastedClassList } from "./classParser";
import { rankFiles } from "./matcher";
import { showResultsQuickPick } from "./quickPick";

let indexer: WorkspaceIndexer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Smart Class Lookup");
  context.subscriptions.push(output);

  indexer = new WorkspaceIndexer(output);
  context.subscriptions.push(indexer);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = "smartClassLookup.search";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    indexer.onDidUpdate(() => updateStatusBar())
  );

  // Kick off the initial index build in the background; don't block activation.
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
    })
  );
}

function updateStatusBar(building = false): void {
  if (!statusBarItem || !indexer) return;
  statusBarItem.text = building
    ? "$(sync~spin) Smart Class Lookup: indexing…"
    : `$(search) Smart Class Lookup (${indexer.fileCount} files)`;
  statusBarItem.tooltip = "Click to run Smart Class Lookup";
}

async function runSearchCommand(): Promise<void> {
  if (!indexer) return;

  const raw = await vscode.window.showInputBox({
    title: "Smart Class Lookup",
    prompt: "Paste the full class list you copied from DevTools",
    placeHolder: "relative z-[1050] bg-base-200 px-5 pb-5 pt-4 rounded-2xl shadow-md mb-12",
    ignoreFocusOut: true,
  });

  if (raw === undefined || raw.trim().length === 0) {
    return;
  }

  const inputClasses = parsePastedClassList(raw);
  if (inputClasses.length === 0) {
    vscode.window.showWarningMessage("Smart Class Lookup: no class names were found in that input.");
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
