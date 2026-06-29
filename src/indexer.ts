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
 *
 * Index cache: after each full build the index is serialized into VS Code's
 * workspaceState storage. On the next activation only files whose on-disk
 * mtime changed since the last run are re-parsed, so large repos skip the
 * full scan on every restart.
 */

import * as path from "path";
import * as vscode from "vscode";
import { extractClassesFromSource } from "./astExtractor";
import type { ClassLocation, FileIndexEntry } from "./types";

const DEFAULT_INCLUDE = "**/*.{ts,tsx,js,jsx}";
const DEFAULT_EXCLUDE = "**/{node_modules,.next,dist,build,coverage,.git,out}/**";

const CACHE_KEY = "smartClassLookup.indexCache.v1";

interface CachedEntry {
  file: string;
  mtimeMs: number;
  classes: string[];
  locations: Record<string, ClassLocation[]>;
}

interface IndexCache {
  include: string;
  exclude: string;
  entries: CachedEntry[];
}

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

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {}

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

    // Load cache and check if config matches.
    const cache = this.context.workspaceState.get<IndexCache>(CACHE_KEY);
    const cacheValid = cache && cache.include === include && cache.exclude === exclude;

    if (cacheValid) {
      // Warm the index from cache first (instant).
      this.index.clear();
      this.classToFiles.clear();
      for (const entry of cache.entries) {
        this.addEntryToIndex(entry.file, {
          file: entry.file,
          classes: new Set(entry.classes),
          locations: new Map(Object.entries(entry.locations)),
          mtimeMs: entry.mtimeMs,
        });
      }
      this.output.appendLine(`[index] loaded ${cache.entries.length} files from cache`);
    } else {
      this.index.clear();
      this.classToFiles.clear();
    }

    // Find all workspace files matching the glob.
    const uris = await vscode.workspace.findFiles(include, exclude);
    this.output.appendLine(`[index] scanning ${uris.length} files (incremental: ${cacheValid ? "yes" : "no"})...`);

    // Parse only files that are new or changed since the last cache build.
    const CONCURRENCY = 16;
    let cursor = 0;

    const worker = async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor++];
        const filePath = uri.fsPath;

        if (cacheValid) {
          // Stat the file to get its real mtime.
          let stat: vscode.FileStat;
          try {
            stat = await vscode.workspace.fs.stat(uri);
          } catch {
            // File disappeared — remove from index.
            this.removeFile(filePath);
            continue;
          }
          const cached = this.index.get(filePath);
          if (cached && cached.mtimeMs >= stat.mtime) {
            continue; // cache hit — skip re-parse
          }
        }

        await this.indexFile(uri);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uris.length || 1) }, worker));

    // Remove cached entries for files that no longer exist.
    const uriSet = new Set(uris.map((u) => u.fsPath));
    for (const filePath of this.index.keys()) {
      if (!uriSet.has(filePath)) {
        this.removeFile(filePath);
      }
    }

    this.fileCount = this.index.size;
    this.lastBuildMs = Date.now() - start;
    this.output.appendLine(
      `[index] built index for ${this.fileCount} files with classes in ${this.lastBuildMs}ms`
    );

    // Persist the updated index to workspace state.
    await this.saveCache(include, exclude);

    this.onDidUpdateEmitter.fire();
  }

  /** Serialize the current index to workspaceState. */
  private async saveCache(include: string, exclude: string): Promise<void> {
    const entries: CachedEntry[] = [];
    for (const entry of this.index.values()) {
      entries.push({
        file: entry.file,
        mtimeMs: entry.mtimeMs,
        classes: [...entry.classes],
        locations: Object.fromEntries(entry.locations),
      });
    }
    const cache: IndexCache = { include, exclude, entries };
    await this.context.workspaceState.update(CACHE_KEY, cache);
  }

  /** Add a fully-built FileIndexEntry into both maps. */
  private addEntryToIndex(filePath: string, entry: FileIndexEntry): void {
    this.index.set(filePath, entry);
    for (const cls of entry.classes) {
      let set = this.classToFiles.get(cls);
      if (!set) {
        set = new Set();
        this.classToFiles.set(cls, set);
      }
      set.add(filePath);
    }
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

    // Get the real mtime so the cache can detect future changes correctly.
    let mtimeMs = Date.now();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      mtimeMs = stat.mtime;
    } catch {
      // ignore — fall back to Date.now()
    }

    // Remove stale reverse-index entries from any previous version of this file.
    this.removeFile(filePath);
    this.addEntryToIndex(filePath, { file: filePath, classes: classSet, locations, mtimeMs });
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
    // Update the cache incrementally after each file change.
    const { include, exclude } = this.getConfig();
    await this.saveCache(include, exclude);
  }

  private isExcluded(filePath: string): boolean {
    const { exclude } = this.getConfig();
    // ponytail: cheap practical check covers common excluded directory names
    // without pulling in a glob dependency. Ceiling: won't handle complex
    // negation patterns; upgrade path is to add micromatch.
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

