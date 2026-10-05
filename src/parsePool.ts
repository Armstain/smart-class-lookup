import * as os from "os";
import * as path from "path";
import { Worker, isMainThread, parentPort } from "worker_threads";
import { parseSource, type ParsedFile } from "./astExtractor";

// This file is also the worker entry (bundled to its own dist/parsePool.js), so the pool and the
// code it runs can't drift apart.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", ({ source, filePath }: { source: string; filePath: string }) =>
    port.postMessage(parseSource(source, filePath))
  );
}

const WORKER_PATH = path.join(__dirname, "parsePool.js");

// Babel parsing is synchronous; on the extension host thread a cold build froze every other
// extension until it finished. Capped at half the cores so indexing never competes with the editor
// for CPU. Workers spawn on demand, so a warm start with a handful of changed files stays cheap.
export class ParsePool {
  private readonly size = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  private idle: Worker[] = [];
  private waiting: Array<(worker: Worker) => void> = [];
  private spawned = 0;

  // Never rejects: a worker that dies on a file turns into a parse error for that file only.
  public async parse(source: string, filePath: string): Promise<ParsedFile> {
    const worker = await this.acquire();
    return new Promise<ParsedFile>((resolve) => {
      const onMessage = (result: ParsedFile) => {
        worker.off("error", onError);
        this.release(worker);
        resolve(result);
      };
      const onError = (err: Error) => {
        worker.off("message", onMessage);
        void worker.terminate();
        this.release(new Worker(WORKER_PATH));
        resolve({ classes: new Set(), locations: new Map(), fastSkip: false, parseError: `worker: ${err.message}` });
      };
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.postMessage({ source, filePath });
    });
  }

  private acquire(): Promise<Worker> {
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    if (this.spawned < this.size) {
      this.spawned++;
      return Promise.resolve(new Worker(WORKER_PATH));
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  public dispose(): void {
    for (const worker of this.idle) void worker.terminate();
    this.idle = [];
  }
}
