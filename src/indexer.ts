/**
 * Builds and maintains an in-memory index of:
 *
 *   class name -> file -> [locations]
 *
 * (modeled here as `file -> FileIndexEntry { classes, locations }`, with a
 * secondary `classToFiles` map for fast candidate lookup).
 *
 * The initial build scans the whole workspace once. After that, a
 * FileSystemWatcher keeps the index up to date incrementally -- only the
 * file that actually changed gets re-parsed, so subsequent searches stay
 * "nearly instant" even in large repos.
 */

import * as path from "path";
import * as vscode from "vscode";
import { extractClassesFromSource } from "./astExtractor";
import type { ClassLocation, FileIndexEntry } from "./types";

const DEFAULT_INCLUDE = "**/*.{ts,tsx,js,jsx}";
const DEFAULT_EXCLUDE = "**/{node_modules,.next,dist,build,coverage,.git,out}/**";

export class WorkspaceIndexer implements vscode.Disposable {
  private index = new Map<string, FileIndexEntry>();
  private classToFiles = new Map<string, Set<string>>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the index finishes an (re)build, so the UI can refresh status. */
  public readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private building: Promise<void> | undefined;
  public fileCount = 0;
  public lastBuildMs = 0;

  constructor(private readonly output: vscode.OutputChannel) {}

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration("smartClassLookup");
    return {
      include: cfg.get<string>("include", DEFAULT_INCLUDE),
      exclude: cfg.get<string>("exclude", DEFAULT_EXCLUDE),
    };
  }

  /** Full workspace scan. Safe to call multiple times (e.g. manual rebuild). */
  public async buildFullIndex(): Promise<void> {
    if (this.building) {
      return this.building;
    }
    this.building = this.doBuildFullIndex();
    try {
      await this.building;
    } finally {
      this.building = undefined;
    }
  }

  private async doBuildFullIndex(): Promise<void> {
    const start = Date.now();
    const { include, exclude } = this.getConfig();

    this.index.clear();
    this.classToFiles.clear();

    const uris = await vscode.workspace.findFiles(include, exclude);
    this.output.appendLine(`[index] scanning ${uris.length} files...`);

    // Parse files with a small concurrency cap so we don't open thousands of
    // file handles at once on huge repos.
    const CONCURRENCY = 16;
    let cursor = 0;
    const worker = async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor++];
        await this.indexFile(uri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uris.length) }, worker));

    this.fileCount = this.index.size;
    this.lastBuildMs = Date.now() - start;
    this.output.appendLine(
      `[index] built index for ${this.fileCount} files with classes in ${this.lastBuildMs}ms`
    );
    this.onDidUpdateEmitter.fire();
  }

  /** (Re)parse a single file and merge it into the index. */
  private async indexFile(uri: vscode.Uri): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return; // file may have been deleted between findFiles() and now
    }

    const source = Buffer.from(bytes).toString("utf8");
    const filePath = uri.fsPath;
    const { classes, parseError } = extractClassesFromSource(source, filePath);

    if (parseError) {
      // Don't fail the whole index over one unparsable file (e.g. a file
      // using bleeding-edge syntax our plugin set doesn't cover).
      this.output.appendLine(`[index] skipped ${filePath}: ${parseError}`);
      this.removeFile(filePath);
      return;
    }

    if (classes.length === 0) {
      this.removeFile(filePath);
      return;
    }

    const classSet = new Set<string>();
    const locations = new Map<string, ClassLocation[]>();

    for (const { className, location } of classes) {
      classSet.add(className);
      const list = locations.get(className);
      if (list) {
        if (list.length < 8) list.push(location); // cap per-class locations
      } else {
        locations.set(className, [location]);
      }
    }

    // Remove stale reverse-index entries from any previous version of this file.
    this.removeFile(filePath);

    this.index.set(filePath, { file: filePath, classes: classSet, locations, mtimeMs: Date.now() });
    for (const cls of classSet) {
      let set = this.classToFiles.get(cls);
      if (!set) {
        set = new Set();
        this.classToFiles.set(cls, set);
      }
      set.add(filePath);
    }
  }

  private removeFile(filePath: string): void {
    const existing = this.index.get(filePath);
    if (!existing) return;
    for (const cls of existing.classes) {
      const set = this.classToFiles.get(cls);
      if (set) {
        set.delete(filePath);
        if (set.size === 0) this.classToFiles.delete(cls);
      }
    }
    this.index.delete(filePath);
  }

  /** Start watching the workspace for changes and keep the index in sync. */
  public startWatching(): void {
    const { include } = this.getConfig();
    this.watcher = vscode.workspace.createFileSystemWatcher(include);

    this.disposables.push(
      this.watcher,
      this.watcher.onDidChange((uri) => this.handleFileChanged(uri)),
      this.watcher.onDidCreate((uri) => this.handleFileChanged(uri)),
      this.watcher.onDidDelete((uri) => {
        this.removeFile(uri.fsPath);
        this.fileCount = this.index.size;
        this.onDidUpdateEmitter.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("smartClassLookup.include") ||
          e.affectsConfiguration("smartClassLookup.exclude")
        ) {
          this.watcher?.dispose();
          this.startWatching();
          void this.buildFullIndex();
        }
      })
    );
  }

  private async handleFileChanged(uri: vscode.Uri): Promise<void> {
    if (this.isExcluded(uri.fsPath)) return;
    await this.indexFile(uri);
    this.fileCount = this.index.size;
    this.onDidUpdateEmitter.fire();
  }

  private isExcluded(filePath: string): boolean {
    const { exclude } = this.getConfig();
    // vscode doesn't expose a glob-tester directly; a cheap practical check
    // covers the common excluded directory names without pulling in a glob
    // dependency just for this.
    const excludedDirs = exclude.match(/\{([^}]+)\}/)?.[1]?.split(",") ?? [];
    return excludedDirs.some((dir) => filePath.includes(`${path.sep}${dir}${path.sep}`));
  }

  public getIndex(): Map<string, FileIndexEntry> {
    return this.index;
  }

  public dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.onDidUpdateEmitter.dispose();
  }
}
