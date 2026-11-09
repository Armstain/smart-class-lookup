import * as path from "path";
import * as vscode from "vscode";
import { clearHighlight, displayPath, revealLocations, uniqueLines } from "./editor";
import { settings } from "./settings";
import type { SearchResult } from "./types";

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

interface Item extends vscode.QuickPickItem {
  result: SearchResult;
  locationIndex: number;
}

function buildItems(result: SearchResult): Item[] {
  const relativePath = displayPath(result.file);

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

  const dedupedLocations = uniqueLines(result.locations);

  const description = isTextOnly
    ? "$(search) text match"
    : `${formatPercent(result.score)} match  (${result.matchedCount}/${result.totalInputCount})${
        result.matchType === "both" ? "  $(search) +text" : ""
      }`;

  const fileItem: Item = {
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

  const locationItems: Item[] = dedupedLocations.map((loc) => ({
    result,
    locationIndex: result.locations.indexOf(loc),
    label: `    $(symbol-keyword) Line ${loc.line + 1}`,
    description: ``,
    detail: `    ${loc.context.slice(0, 100)}`,
  }));

  return [fileItem, ...locationItems];
}

export async function showResultsQuickPick(results: SearchResult[]): Promise<void> {
  if (results.length === 0) {
    vscode.window.showInformationMessage(
      "Smart Class Search: no files matched any of the pasted classes."
    );
    return;
  }

  const items: Item[] = results.flatMap(buildItems);

  const originalEditor = vscode.window.activeTextEditor;
  let previewEditor: vscode.TextEditor | undefined;

  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.title = `Smart Class Search — ${results.length} match${results.length === 1 ? "" : "es"}`;
  qp.placeholder = "Select a result to open it at the matching line";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const subs: vscode.Disposable[] = [];

  if (settings().enablePreview) {
    subs.push(
      qp.onDidChangeActive(async (activeItems) => {
        const active = activeItems[0];
        if (!active) return;
        previewEditor = await revealLocations(active.result.file, active.result.locations, active.locationIndex, true);
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
    clearHighlight(previewEditor);
    if (originalEditor) {
      await vscode.window.showTextDocument(originalEditor.document, {
        viewColumn: originalEditor.viewColumn,
        selection: originalEditor.selection,
        preview: false,
      });
    }
    return;
  }

  await revealLocations(picked.result.file, picked.result.locations, picked.locationIndex, false);
}
