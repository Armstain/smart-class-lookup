import * as vscode from "vscode";
import { parseSource } from "./astExtractor";
import { buildArbitraryIndex } from "./classParser";
import { globToRegExp } from "./glob";
import { ParsePool } from "./parsePool";
import type { ClassLocation, FileIndexEntry } from "./types";

const DEFAULT_INCLUDE =
  "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte,astro,html,htm,php,erb,twig,hbs,css,scss,sass,less}";
const DEFAULT_EXCLUDE = "**/{node_modules,.next,dist,build,coverage,.git,out}/**";

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
  private classToFiles = new Map<string, Set<string>>();
  private watcherDisposables: vscode.Disposable[] = [];
  private disposables: vscode.Disposable[] = [];

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  public readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private building: Promise<void> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  public fileCount = 0;
  public lastBuildMs = 0;
  private fastSkipCount = 0;
  private configWatcherRegistered = false;
  private excludeRegex: { glob: string; re: RegExp } | undefined;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {}

  public get isBuilding(): boolean {
    return this.building !== undefined;
  }

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration("smartClassLookup");
    return {
      include: cfg.get<string>("include", DEFAULT_INCLUDE),
      exclude: cfg.get<string>("exclude", DEFAULT_EXCLUDE),
    };
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
      this.fileCount = this.index.size;
      this.onDidUpdateEmitter.fire();
    }
  }

  private async doBuildFullIndex(): Promise<void> {
    const start = Date.now();
    this.fastSkipCount = 0;
    const { include, exclude } = this.getConfig();

    const cache = await this.loadCache();
    const cacheValid = !!cache && cache.include === include && cache.exclude === exclude;

    this.index.clear();
    this.classToFiles.clear();
    if (cache && cacheValid) {
      for (const entry of cache.entries) {
        this.addEntryToIndex(entry.file, {
          file: entry.file,
          classes: new Set(entry.classes),
          locations: new Map(Object.entries(entry.locations)),
          mtimeMs: entry.mtimeMs,
        });
      }
      this.fileCount = this.index.size;
      this.output.appendLine(`[index] loaded ${cache.entries.length} files from cache`);
    }

    const uris = await vscode.workspace.findFiles(include, exclude);
    this.output.appendLine(`[index] scanning ${uris.length} files (incremental: ${cacheValid ? "yes" : "no"})...`);

    // Workers live only for the build: each holds its own copy of Babel, and watcher events are
    // one file at a time, cheap enough to parse inline.
    const pool = new ParsePool();
    const CONCURRENCY = 16;
    let cursor = 0;
    // Skip the save below when a fully-cached reload changes nothing.
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
            this.removeFile(filePath);
            changed = true;
            continue;
          }
          const cached = this.index.get(filePath);
          if (cached && cached.mtimeMs >= stat.mtime) {
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
        this.removeFile(filePath);
        changed = true;
      }
    }

    this.fileCount = this.index.size;
    this.lastBuildMs = Date.now() - start;
    this.output.appendLine(
      `[index] built index for ${this.fileCount} files with classes in ${this.lastBuildMs}ms` +
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
      const { include, exclude } = this.getConfig();
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
      return undefined; // missing or corrupt cache just means a full parse
    }
  }

  private async saveCache(include: string, exclude: string): Promise<void> {
    const uri = this.cacheUri();
    if (!this.context.storageUri) return;
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
      await vscode.workspace.fs.createDirectory(this.context.storageUri);
      await vscode.workspace.fs.writeFile(uri!, Buffer.from(JSON.stringify(cache), "utf8"));
    } catch (err) {
      this.output.appendLine(`[index] cache save failed: ${errorMessage(err)}`);
    }
  }

  private addEntryToIndex(filePath: string, entry: FileIndexEntry): void {
    entry.arbitraryIndex = buildArbitraryIndex(entry.classes);
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

  private async indexFile(uri: vscode.Uri, pool?: ParsePool, knownStat?: vscode.FileStat): Promise<void> {
    const filePath = uri.fsPath;
    let stat: vscode.FileStat;
    let bytes: Uint8Array;
    try {
      stat = knownStat ?? (await vscode.workspace.fs.stat(uri));
      if (stat.size > MAX_FILE_BYTES || MINIFIED_RE.test(filePath)) {
        this.output.appendLine(`[index] skipped ${filePath}: minified or larger than ${MAX_FILE_BYTES / 1024} KB`);
        this.removeFile(filePath);
        return;
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      this.removeFile(filePath); // deleted between findFiles() and now
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

    this.removeFile(filePath);
    this.addEntryToIndex(filePath, { file: filePath, classes, locations, mtimeMs: stat.mtime, source });
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

  public startWatching(): void {
    for (const d of this.watcherDisposables) d.dispose();
    const { include } = this.getConfig();
    const watcher = vscode.workspace.createFileSystemWatcher(include);

    this.watcherDisposables = [
      watcher,
      watcher.onDidChange((uri) => void this.handleFileChanged(uri)),
      watcher.onDidCreate((uri) => void this.handleFileChanged(uri)),
      watcher.onDidDelete((uri) => {
        this.removeFile(uri.fsPath);
        this.fileCount = this.index.size;
        this.onDidUpdateEmitter.fire();
        this.scheduleCacheSave();
      }),
    ];

    // Registered once — startWatching() re-runs on config changes, and re-adding this
    // listener each time would stack duplicate rebuilds.
    if (!this.configWatcherRegistered) {
      this.configWatcherRegistered = true;
      this.disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (
            e.affectsConfiguration("smartClassLookup.include") ||
            e.affectsConfiguration("smartClassLookup.exclude")
          ) {
            this.startWatching();
            void this.buildFullIndex();
          }
        })
      );
    }
  }

  private async handleFileChanged(uri: vscode.Uri): Promise<void> {
    if (this.isExcluded(uri)) return;
    await this.indexFile(uri);
    this.fileCount = this.index.size;
    this.onDidUpdateEmitter.fire();
    this.scheduleCacheSave();
  }

  // The watcher takes no exclude glob, so events from node_modules etc. are filtered here with the
  // same pattern findFiles() uses — relative to the workspace folder, forward slashes.
  private isExcluded(uri: vscode.Uri): boolean {
    const { exclude } = this.getConfig();
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
