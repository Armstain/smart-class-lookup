import * as path from "path";
import * as vscode from "vscode";
import { applyReplace, clipboardQuery, previewReplace, reportReplace, searchIndex } from "./actions";
import { clearHighlight, displayPath, revealLocations, uniqueLines } from "./editor";
import { WorkspaceIndexer } from "./indexer";
import { queryTerms } from "./matcher";
import { parseQuery, parseReplace } from "./query";
import { onDidChangeSetting, setEnablePreview, settings } from "./settings";
import { sidebarHtml, type SidebarState } from "./sidebarHtml";
import type { ClassLocation } from "./types";

type Location = Pick<ClassLocation, "line" | "column">;

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private previewEditor?: vscode.TextEditor;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly indexer: WorkspaceIndexer
  ) {
    this.subscriptions = [
      this.indexer.onDidUpdate(() => this.postState(true)),
      onDidChangeSetting(["enablePreview"], () => this.postState(false)),
    ];
  }

  public dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  private state(): SidebarState {
    return { fileCount: this.indexer.fileCount, building: this.indexer.isBuilding, enablePreview: settings().enablePreview };
  }

  private postState(indexChanged: boolean): void {
    this.post({ type: "state", indexChanged, ...this.state() });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.onDidReceiveMessage((data) =>
      this.handleMessage(data).catch((err) =>
        vscode.window.showErrorMessage(`Smart Class Search: ${err instanceof Error ? err.message : String(err)}`)
      )
    );
    webviewView.webview.html = sidebarHtml(this.state());
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.postState(false);
    });
  }

  private async reveal(file: string, locations: Location[], index: number, preview: boolean): Promise<void> {
    const editor = await revealLocations(file, locations, index, preview);
    this.previewEditor = preview ? editor : undefined;
  }

  private async handleMessage(data: any): Promise<void> {
    switch (data.type) {
      case "ready": {
        const query = await clipboardQuery();
        if (query) this.post({ type: "clipboardText", text: query });
        break;
      }
      case "search": {
        const raw = data.value as string;
        const results = raw.trim() ? searchIndex(this.indexer.getIndex(), parseQuery(raw)) : [];
        this.post({
          type: "results",
          terms: queryTerms(raw),
          results: results.map((r) => ({
            ...r,
            fileName: path.basename(r.file),
            relativePath: displayPath(r.file),
            locations: uniqueLines(r.locations),
          })),
        });
        break;
      }
      case "previewReplace": {
        const target = data.target as string;
        const replacement = data.replacement as string;
        if (!target?.trim()) return;
        const occurrences = await previewReplace(this.indexer.getIndex(), parseReplace(target, replacement));
        this.post({
          type: "replacePreview",
          target,
          replacement,
          occurrences: occurrences.map((o) => ({
            ...o,
            fileName: path.basename(o.file),
            relativePath: displayPath(o.file),
          })),
        });
        break;
      }
      case "applyReplace": {
        const target = data.target as string;
        const selectedKeys = new Set<string>((data.selectedKeys as string[]) ?? []);
        if (!target?.trim() || selectedKeys.size === 0) return;
        const spec = parseReplace(target, data.replacement as string);
        reportReplace(await applyReplace(this.indexer.getIndex(), spec, selectedKeys));
        this.post({ type: "resultsUpdated" });
        break;
      }
      case "preview":
      case "open":
        await this.reveal(data.result.file, data.result.locations, data.locationIndex as number, data.type === "preview");
        break;
      case "previewOccurrence":
      case "openOccurrence":
        await this.reveal(data.file, [{ line: data.line as number, column: 0 }], 0, data.type === "previewOccurrence");
        break;
      case "togglePreview":
        await setEnablePreview(data.enabled as boolean);
        break;
      case "clearPreview":
        clearHighlight(this.previewEditor);
        this.previewEditor = undefined;
        break;
      case "copy":
        if (data.text) {
          await vscode.env.clipboard.writeText(data.text as string);
          vscode.window.setStatusBarMessage("$(check) Copied to clipboard", 2000);
        }
        break;
    }
  }
}
