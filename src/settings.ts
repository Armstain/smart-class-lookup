import * as vscode from "vscode";

const SECTION = "smartClassLookup";

export interface Settings {
  include: string;
  exclude: string;
  maxResults: number;
  minScore: number;
  enablePreview: boolean;
  duplicateMinClasses: number;
}

// Defaults live in package.json's contributes.configuration, which VS Code always applies.
export function settings(): Settings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    include: cfg.get<string>("include")!,
    exclude: cfg.get<string>("exclude")!,
    maxResults: cfg.get<number>("maxResults")!,
    minScore: cfg.get<number>("minScore")!,
    enablePreview: cfg.get<boolean>("enablePreview")!,
    duplicateMinClasses: cfg.get<number>("duplicateMinClasses")!,
  };
}

export function setEnablePreview(enabled: boolean): Thenable<void> {
  return vscode.workspace.getConfiguration(SECTION).update("enablePreview", enabled, vscode.ConfigurationTarget.Global);
}

export function onDidChangeSetting(keys: (keyof Settings)[], listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (keys.some((key) => e.affectsConfiguration(`${SECTION}.${key}`))) listener();
  });
}
