import * as vscode from "vscode";
import type { ReplaceSpec } from "./classReplacer";
import { rankFiles } from "./matcher";
import { queryFromClipboard, type ParsedQuery } from "./query";
import {
  applySelectedEdits,
  collectReplacements,
  filterCandidateFiles,
  type ReplaceOccurrence,
} from "./replacePreview";
import { settings } from "./settings";
import type { FileIndexEntry, SearchResult } from "./types";

type Index = Map<string, FileIndexEntry>;

export function searchIndex(index: Index, query: ParsedQuery): SearchResult[] {
  const { minScore, maxResults } = settings();
  return rankFiles(query.classes, index, { minScore, maxResults, rawInput: query.text });
}

// Open editor buffers win over disk, so unsaved changes are what gets previewed and replaced.
async function openDocuments(files: string[]): Promise<Map<string, vscode.TextDocument>> {
  const documents = new Map<string, vscode.TextDocument>();
  for (const file of files) {
    try {
      documents.set(file, await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    } catch {
      continue;
    }
  }
  return documents;
}

function textsOf(documents: Map<string, vscode.TextDocument>): Map<string, string> {
  return new Map([...documents].map(([file, document]) => [file, document.getText()]));
}

export async function previewReplace(index: Index, spec: ReplaceSpec): Promise<ReplaceOccurrence[]> {
  const files = filterCandidateFiles(index, spec);
  return files.length === 0 ? [] : collectReplacements(textsOf(await openDocuments(files)), spec);
}

export interface ReplaceOutcome {
  applied: number;
  files: number;
  skipped: number;
  ok: boolean;
}

export async function applyReplace(index: Index, spec: ReplaceSpec, selectedKeys: Set<string>): Promise<ReplaceOutcome> {
  const documents = await openDocuments(filterCandidateFiles(index, spec));
  const { applied, skippedCount } = applySelectedEdits(textsOf(documents), spec, selectedKeys);

  const workspaceEdit = new vscode.WorkspaceEdit();
  const files = new Set<string>();
  for (const edit of applied) {
    const document = documents.get(edit.file)!;
    workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.newText);
    files.add(edit.file);
  }

  const ok = applied.length > 0 && (await vscode.workspace.applyEdit(workspaceEdit));
  return { applied: applied.length, files: files.size, skipped: skippedCount, ok };
}

export function reportReplace(outcome: ReplaceOutcome): void {
  if (outcome.applied === 0) {
    vscode.window.showInformationMessage(
      outcome.skipped > 0
        ? "Smart Class Replace: selected occurrences are no longer present (file changed since preview) — nothing applied."
        : "Smart Class Replace: nothing selected to apply."
    );
  } else if (outcome.ok) {
    const skippedNote = outcome.skipped > 0 ? ` (${outcome.skipped} skipped — file changed since preview)` : "";
    vscode.window.showInformationMessage(
      `Smart Class Replace: applied ${outcome.applied} occurrence(s) in ${outcome.files} file(s)${skippedNote}.`
    );
  } else {
    vscode.window.showErrorMessage("Smart Class Replace: Failed to apply edits.");
  }
}

export async function clipboardQuery(): Promise<string | undefined> {
  const text = await vscode.env.clipboard.readText().then(undefined, () => "");
  return queryFromClipboard(text);
}
