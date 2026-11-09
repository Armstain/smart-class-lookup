import * as vscode from "vscode";
import { parseSource } from "./astExtractor";
import { buildArbitraryIndex } from "./classParser";
import { globToRegExp } from "./glob";
import { ParsePool } from "./parsePool";
import { onDidChangeSetting, settings } from "./settings";
import { SourceText } from "./text";
import type { ClassLocation, FileIndexEntry } from "./types";

const CACHE_FILE = "index-cache-v2.json";
const LEGACY_CACHE_KEY = "smartClassLookup.indexCache.v2";

// Parsing is synchronous, so a stray bundle or minified vendor file can stall a parse worker (or
// the extension host, for watcher events) for minutes. Hand-written components never get near this size.
const MAX_FILE_BYTES = 1024 * 1024;
const MINIFIED_RE = /\.min\.[^\\/]+$/i;

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class WorkspaceIndexer implements vscode.Disposable {
  private index = new Map<string, FileIndexEntry>();
  private watcherDisposables: vscode.Disposable[] = [];
  private disposables: vscode.Disposable[] = [];

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  public readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private building: Promise<void> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private fastSkipCount = 0;
  private excludeRegex: { glob: string; re: RegExp } | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.disposables.push(onDidChangeSetting(["include", "exclude"], () => void this.start()));
  }

  public get isBuilding(): boolean {
    return this.building !== undefined;
  }

  public get fileCount(): number {
    return this.index.size;
  }

  // Never rejects: every caller fires and forgets, and a rejected build used to leave the UI on
  // "indexing…" with the watcher never started.
  public async buildFullIndex(): Promise<void> {
    if (this.building) {
      return this.building;
    }
    this.building = this.doBuildFullIndex().catch((err) => {
      this.output.appendLine(`[index] build failed: ${errorMessage(err)}`);
    });
    this.onDidUpdateEmitter.fire();
    try {
      await this.building;
    } finally {
      this.building = undefined;
      this.onDidUpdateEmitter.fire();
    }
  }

  private async doBuildFullIndex(): Promise<void> {
    const start = Date.now();
    this.fastSkipCount = 0;
    const { include, exclude } = settings();

    const cache = await this.loadCache();
    const cacheValid = !!cache && cache.include === include && cache.exclude === exclude;

    this.index.clear();
    if (cache && cacheValid) {
      for (const entry of cache.entries) {
        this.addEntryToIndex({
          file: entry.file,
          classes: new Set(entry.classes),
          locations: new Map(Object.entries(entry.locations)),
          mtimeMs: entry.mtimeMs,
        });
      }
      this.output.appendLine(`[index] loaded ${cache.entries.length} files from cache`);
    }

    const uris = await vscode.workspace.findFiles(include, exclude);
    this.output.appendLine(`[index] scanning ${uris.length} files (incremental: ${cacheValid ? "yes" : "no"})...`);

    // Workers live only for the build: each holds its own copy of Babel, and watcher events are
    // one file at a time, cheap enough to parse inline.
    const pool = new ParsePool();
    const CONCURRENCY = 16;
    let cursor = 0;
    let changed = !cacheValid;

    const worker = async () => {
      while (cursor < uris.length) {
        const uri = uris[cursor++];
        const filePath = uri.fsPath;

        let stat: vscode.FileStat | undefined;
        if (cacheValid) {
          try {
            stat = await vscode.workspace.fs.stat(uri);
          } catch {
            this.index.delete(filePath);
            changed = true;
            continue;
          }
          const cached = this.index.get(filePath);
          if (cached && cached.mtimeMs >= stat.mtime) {
            await this.loadText(uri, cached);
            continue;
          }
        }

        await this.indexFile(uri, pool, stat);
        changed = true;
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uris.length || 1) }, worker));
    } finally {
      pool.dispose();
    }

    const uriSet = new Set(uris.map((u) => u.fsPath));
    for (const filePath of this.index.keys()) {
      if (!uriSet.has(filePath)) {
        this.index.delete(filePath);
        changed = true;
      }
    }

    this.output.appendLine(
      `[index] built index for ${this.fileCount} files with classes in ${Date.now() - start}ms` +
        (this.fastSkipCount > 0 ? ` (skipped parsing ${this.fastSkipCount} files with no possible classes)` : "")
    );

    if (changed) {
      await this.saveCache(include, exclude);
    }
  }

  // The cache is rewritten in full every time, so a burst of file events — a formatter sweeping the
  // repo, a branch switch, a build writing into a watched folder — would otherwise serialize the
  // entire index once per file. Losing a pending write costs nothing: the mtime check re-parses
  // those files on the next start.
  private scheduleCacheSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const { include, exclude } = settings();
      void this.saveCache(include, exclude);
    }, 2000);
  }

  private cacheUri(): vscode.Uri | undefined {
    const dir = this.context.storageUri;
    return dir && vscode.Uri.joinPath(dir, CACHE_FILE);
  }

  // The cache lives in a file, not workspaceState: that store is a SQLite row VS Code loads eagerly
  // and isn't meant for megabytes of index data.
  private async loadCache(): Promise<IndexCache | undefined> {
    if (this.context.workspaceState.get(LEGACY_CACHE_KEY) !== undefined) {
      void this.context.workspaceState.update(LEGACY_CACHE_KEY, undefined);
    }
    const uri = this.cacheUri();
    if (!uri) return undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as IndexCache;
    } catch {
      return undefined;
    }
  }

  private async saveCache(include: string, exclude: string): Promise<void> {
    const dir = this.context.storageUri;
    const uri = this.cacheUri();
    if (!dir || !uri) return;
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
    try {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(cache), "utf8"));
    } catch (err) {
      this.output.appendLine(`[index] cache save failed: ${errorMessage(err)}`);
    }
  }

  private addEntryToIndex(entry: FileIndexEntry): void {
    entry.arbitraryIndex = buildArbitraryIndex(entry.classes);
    this.index.set(entry.file, entry);
  }

  private async loadText(uri: vscode.Uri, entry: FileIndexEntry): Promise<void> {
    if (entry.text) return;
    try {
      entry.text = new SourceText(entry.file, Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
    } catch {
      entry.text = new SourceText(entry.file, "");
    }
  }

  private async indexFile(uri: vscode.Uri, pool?: ParsePool, knownStat?: vscode.FileStat): Promise<void> {
    const filePath = uri.fsPath;
    let stat: vscode.FileStat;
    let bytes: Uint8Array;
    try {
      stat = knownStat ?? (await vscode.workspace.fs.stat(uri));
      if (stat.size > MAX_FILE_BYTES || MINIFIED_RE.test(filePath)) {
        this.output.appendLine(`[index] skipped ${filePath}: minified or larger than ${MAX_FILE_BYTES / 1024} KB`);
        this.index.delete(filePath);
        return;
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      this.index.delete(filePath); // deleted between findFiles() and now
      return;
    }

    const source = Buffer.from(bytes).toString("utf8");
    const { classes, locations, fastSkip, parseError } = pool
      ? await pool.parse(source, filePath)
      : parseSource(source, filePath);

    if (fastSkip) this.fastSkipCount++;
    // A file that fails to parse stays indexed with no classes, so it's cached (not re-parsed and
    // re-logged every start) and still reachable by plain-text search.
    if (parseError) {
      this.output.appendLine(`[index] skipped ${filePath}: ${parseError}`);
    }

    this.addEntryToIndex({
      file: filePath,
      classes,
      locations,
      mtimeMs: stat.mtime,
      text: new SourceText(filePath, source),
    });
  }

  public async start(): Promise<void> {
    await this.buildFullIndex();
    this.watch();
  }

  private watch(): void {
    for (const d of this.watcherDisposables) d.dispose();
    const { include } = settings();
    const watcher = vscode.workspace.createFileSystemWatcher(include);

    this.watcherDisposables = [
      watcher,
      watcher.onDidChange((uri) => void this.handleFileChanged(uri)),
      watcher.onDidCreate((uri) => void this.handleFileChanged(uri)),
      watcher.onDidDelete((uri) => {
        this.index.delete(uri.fsPath);
        this.onDidUpdateEmitter.fire();
        this.scheduleCacheSave();
      }),
    ];
  }

  private async handleFileChanged(uri: vscode.Uri): Promise<void> {
    if (this.isExcluded(uri)) return;
    await this.indexFile(uri);
    this.onDidUpdateEmitter.fire();
    this.scheduleCacheSave();
  }

  // The watcher takes no exclude glob, so events from node_modules etc. are filtered here with the
  // same pattern findFiles() uses — relative to the workspace folder, forward slashes.
  private isExcluded(uri: vscode.Uri): boolean {
    const { exclude } = settings();
    if (this.excludeRegex?.glob !== exclude) {
      this.excludeRegex = { glob: exclude, re: globToRegExp(exclude) };
    }
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return this.excludeRegex.re.test(relative);
  }

  public getIndex(): Map<string, FileIndexEntry> {
    return this.index;
  }

  public dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const d of this.watcherDisposables) d.dispose();
    for (const d of this.disposables) d.dispose();
    this.onDidUpdateEmitter.dispose();
  }
}
