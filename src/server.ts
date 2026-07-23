import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import { configuredWatchDirectories, loadConfig } from "./config.js";
import { createBuildEngine } from "./engine.js";
import { RebuildScheduler } from "./rebuild-scheduler.js";
import { isPathWithin } from "./utils.js";

type DevOptions = {
  host: string;
  port: number;
};

const DEV_WATCH_OPTIONS = {
  // Delaying unlink events by Chokidar's default 100 ms splits the two halves
  // of a rename across the scheduler's 90 ms maximum batch window.
  atomic: false,
  followSymlinks: false,
  ignoreInitial: true,
} satisfies ChokidarOptions;

type GenerationOperation = {
  kind: "rebuild" | "serve";
  start(): void;
};

/** Keeps output mutation exclusive while allowing unrelated requests to serve concurrently. */
export class ServingGenerationGate {
  readonly #queue: GenerationOperation[] = [];
  #activeReaders = 0;
  #activeWriter = false;

  rebuild<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue("rebuild", operation);
  }

  serve<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue("serve", operation);
  }

  #enqueue<T>(kind: GenerationOperation["kind"], operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        kind,
        start: () => {
          if (kind === "rebuild") this.#activeWriter = true;
          else this.#activeReaders += 1;
          void Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              if (kind === "rebuild") this.#activeWriter = false;
              else this.#activeReaders -= 1;
              this.#drain();
            });
        },
      });
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#activeWriter) return;
    const next = this.#queue[0];
    if (!next) return;
    if (next.kind === "rebuild") {
      if (this.#activeReaders > 0) return;
      this.#queue.shift()?.start();
      return;
    }
    while (this.#queue[0]?.kind === "serve") this.#queue.shift()?.start();
  }
}

export type WatchPathUpdater = {
  add(paths: string | string[]): void;
  unwatch(paths: string | string[]): void;
};

export type RebuildQueue = {
  add(paths: string | readonly string[]): void;
  flush(): Promise<void>;
};

export class WatchEventBuffer {
  readonly #pendingPaths = new Set<string>();
  #closed = false;
  #queue: RebuildQueue | undefined;

  add(changedPath: string): void {
    if (this.#closed) return;
    if (this.#queue) {
      this.#queue.add(changedPath);
      return;
    }
    this.#pendingPaths.add(changedPath);
  }

  async attach(queue: RebuildQueue): Promise<void> {
    if (this.#queue) throw new Error("watch event buffer is already attached");
    if (this.#closed) throw new Error("watch event buffer is closed");

    const pendingPaths = [...this.#pendingPaths].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    this.#pendingPaths.clear();
    this.#queue = queue;
    if (pendingPaths.length) queue.add(pendingPaths);
    await queue.flush();
  }

  close(): void {
    this.#closed = true;
    this.#pendingPaths.clear();
  }
}

export async function attachWatchEventsForServing(
  events: WatchEventBuffer,
  queue: RebuildQueue,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await events.attach(queue);
  } catch (error) {
    // The initial build is valid and remains available. RebuildScheduler keeps
    // the failed paths pending so a later edit can recover without a restart.
    onError(error);
  }
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

export function safeRequestPath(outputDir: string, requestPath: string): string | undefined {
  const segments = requestPath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment.startsWith("."))) return undefined;
  const relative = requestPath.endsWith("/") ? `${requestPath}index.html` : requestPath;
  const target = path.resolve(outputDir, `.${relative}`);
  if (!isPathWithin(outputDir, target)) return undefined;
  return target;
}

export async function safeExistingFilePath(
  outputDir: string,
  requestPath: string,
): Promise<string | undefined> {
  const target = safeRequestPath(outputDir, requestPath);
  if (!target) return undefined;

  let canonicalRoot: string;
  try {
    const rootInfo = await lstat(outputDir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return undefined;
    canonicalRoot = await realpath(outputDir);
  } catch {
    return undefined;
  }

  const relative = path.relative(outputDir, target);
  let cursor = outputDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const canonicalTarget = await realpath(target);
    if (!isPathWithin(canonicalRoot, canonicalTarget)) return undefined;
    const info = await lstat(canonicalTarget);
    return info.isFile() ? canonicalTarget : undefined;
  } catch {
    return undefined;
  }
}

export function waitForWatcherReady(watcher: Pick<FSWatcher, "off" | "once">): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      watcher.off("error", onError);
      resolve();
    };
    const onError = (error: unknown) => {
      watcher.off("ready", onReady);
      reject(error);
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
}

export async function createReadyDevWatcher(
  paths: readonly string[],
  onEvent: (event: string, changedPath: string) => void,
  onError: (error: unknown) => void,
): Promise<FSWatcher> {
  const watcher = watch([...paths], DEV_WATCH_OPTIONS);
  watcher.on("all", onEvent);
  try {
    await waitForWatcherReady(watcher);
  } catch (error) {
    await watcher.close();
    throw error;
  }
  watcher.on("error", onError);
  return watcher;
}

export async function pipeStaticFile(filePath: string, destination: Writable): Promise<void> {
  await pipeline(createReadStream(filePath), destination);
}

function reloadScript(endpoint: string): string {
  return `<script>new EventSource(${JSON.stringify(endpoint)}).addEventListener("reload",function(){location.reload()})</script>`;
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isGeneratedOutputPath(outputDirectory: string, changedPath: string): boolean {
  if (isPathWithin(outputDirectory, changedPath)) return true;
  const outputParent = path.dirname(outputDirectory);
  if (!isPathWithin(outputParent, changedPath)) return false;
  const relative = path.relative(outputParent, changedPath);
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return firstSegment.startsWith(`.${path.basename(outputDirectory)}.inkpath-`);
}

/** Tracks the committed output plus a candidate output while a rebuild is in flight. */
export class GeneratedOutputTracker {
  readonly #directories = new Set<string>();
  #currentDirectory: string;

  constructor(outputDirectory: string) {
    this.#currentDirectory = path.resolve(outputDirectory);
    this.#directories.add(this.#currentDirectory);
  }

  begin(outputDirectory: string): (commit?: boolean) => void {
    const candidate = path.resolve(outputDirectory);
    this.#directories.add(candidate);
    let finished = false;
    return (commit = false) => {
      if (finished) return;
      finished = true;
      if (commit) {
        this.commit(candidate);
      } else if (candidate !== this.#currentDirectory) {
        this.#directories.delete(candidate);
      }
    };
  }

  commit(outputDirectory: string): void {
    this.#currentDirectory = path.resolve(outputDirectory);
    this.#directories.clear();
    this.#directories.add(this.#currentDirectory);
  }

  contains(changedPath: string, sourceDirectories: readonly string[] = []): boolean {
    if (sourceDirectories.some((sourceDirectory) => isPathWithin(sourceDirectory, changedPath))) {
      return false;
    }
    return [...this.#directories].some((outputDirectory) =>
      isGeneratedOutputPath(outputDirectory, changedPath),
    );
  }
}

export function updateWatchedDirectories(
  watcher: WatchPathUpdater,
  currentDirectories: readonly string[],
  nextDirectories: readonly string[],
): string[] {
  const current = new Set(currentDirectories);
  const nextSet = new Set(nextDirectories);
  const next = [...nextSet];
  const added = next.filter((directory) => !current.has(directory));
  const retained = [...current].filter(
    (directory) =>
      !nextSet.has(directory) &&
      next.some(
        (nextDirectory) =>
          isPathWithin(directory, nextDirectory) || isPathWithin(nextDirectory, directory),
      ),
  );
  const removed = [...current].filter(
    (directory) => !nextSet.has(directory) && !retained.includes(directory),
  );

  if (added.length) watcher.add(added);
  if (removed.length) watcher.unwatch(removed);
  return [...next, ...retained];
}

export async function recoverWatchedDirectories(
  watcher: WatchPathUpdater,
  currentDirectories: readonly string[],
  projectDirectory: string,
): Promise<string[]> {
  return updateWatchedDirectories(
    watcher,
    currentDirectories,
    await configuredWatchDirectories(projectDirectory),
  );
}

export async function startDevServer(projectDirectory: string, options: DevOptions): Promise<void> {
  const engine = createBuildEngine(projectDirectory);
  const clients = new Set<ServerResponse>();
  const generationGate = new ServingGenerationGate();
  const watchEvents = new WatchEventBuffer();
  let generatedOutputs: GeneratedOutputTracker | undefined;
  let activeServer: Server | undefined;
  let activeWatcher: FSWatcher | undefined;
  let closing = false;
  let scheduler: RebuildScheduler | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      watchEvents.close();
      const errors: unknown[] = [];
      try {
        await scheduler?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await activeWatcher?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await engine.close();
      } catch (error) {
        errors.push(error);
      }
      for (const client of clients) client.end();
      if (activeServer) {
        try {
          await closeHttpServer(activeServer);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "failed to close the development server");
    })();
    return closePromise;
  };

  try {
    const projectRoot = await realpath(path.resolve(projectDirectory));
    let watchedDirectories = await configuredWatchDirectories(projectRoot);
    let sourceDirectories: readonly string[] = [];
    const configPath = path.join(projectRoot, "inkpath.yaml");
    const onWatchEvent = (_event: string, changedPath: string) => {
      if (!closing && !generatedOutputs?.contains(changedPath, sourceDirectories)) {
        watchEvents.add(changedPath);
      }
    };
    const onWatchError = (error: unknown) => {
      if (!closing) console.error(error instanceof Error ? error.message : error);
    };
    let watcher = await createReadyDevWatcher(
      [...watchedDirectories, configPath],
      onWatchEvent,
      onWatchError,
    );
    activeWatcher = watcher;

    const replaceWatcher = async (nextDirectories: readonly string[]): Promise<void> => {
      const nextWatcher = await createReadyDevWatcher(
        [...nextDirectories, configPath],
        onWatchEvent,
        onWatchError,
      );
      if (closing) {
        await nextWatcher.close();
        throw new Error("development server is closing");
      }
      const previousWatcher = watcher;
      watcher = nextWatcher;
      activeWatcher = nextWatcher;
      watchedDirectories = [...nextDirectories];
      await previousWatcher.close();
    };

    let result = await engine.build();
    const outputTracker = new GeneratedOutputTracker(result.site.config.outputDir);
    generatedOutputs = outputTracker;
    sourceDirectories = [result.site.config.contentDir, result.site.config.publicDir];
    watchedDirectories = updateWatchedDirectories(watcher, watchedDirectories, [
      result.site.config.contentDir,
      result.site.config.publicDir,
    ]);
    const performRebuild = async (changedPaths: readonly string[]): Promise<void> => {
      let candidateOutputDirectory = result.site.config.outputDir;
      if (changedPaths.some((changedPath) => path.resolve(changedPath) === configPath)) {
        let candidateConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
        let candidateWatchDirectories: string[] | undefined;
        try {
          candidateConfig = await loadConfig(projectRoot);
          candidateWatchDirectories = await configuredWatchDirectories(projectRoot);
        } catch {
          // Let the engine report the configuration error while retaining the
          // last-good output root as the only committed ignored directory.
        }
        if (candidateConfig && candidateWatchDirectories) {
          await replaceWatcher(candidateWatchDirectories);
          candidateOutputDirectory = candidateConfig.outputDir;
          sourceDirectories = [candidateConfig.contentDir, candidateConfig.publicDir];
        }
      }
      const finishOutputTracking = outputTracker.begin(candidateOutputDirectory);
      try {
        const nextResult = await engine.rebuild(changedPaths);
        watchedDirectories = updateWatchedDirectories(watcher, watchedDirectories, [
          nextResult.site.config.contentDir,
          nextResult.site.config.publicDir,
        ]);
        sourceDirectories = [nextResult.site.config.contentDir, nextResult.site.config.publicDir];
        if (nextResult.site.config.outputDir === candidateOutputDirectory) {
          finishOutputTracking(true);
        } else {
          finishOutputTracking();
          outputTracker.commit(nextResult.site.config.outputDir);
        }
        result = nextResult;
        for (const client of clients) client.write("event: reload\ndata: reload\n\n");
        console.log(`Rebuilt ${result.pages} pages in ${Math.round(result.elapsedMs)}ms`);
      } catch (error) {
        try {
          watchedDirectories = await recoverWatchedDirectories(
            watcher,
            watchedDirectories,
            projectDirectory,
          );
        } catch {
          // Invalid YAML/configuration is still recoverable through inkpath.yaml,
          // which remains watched independently.
        }
        finishOutputTracking();
        throw error;
      }
    };
    let reportScheduledErrors = false;
    scheduler = new RebuildScheduler(
      (changedPaths) => generationGate.rebuild(() => performRebuild(changedPaths)),
      {
        onError(error) {
          if (reportScheduledErrors) {
            console.error(error instanceof Error ? error.message : error);
          }
        },
      },
    );
    await attachWatchEventsForServing(watchEvents, scheduler, (error) => {
      console.error(error instanceof Error ? error.message : error);
    });
    reportScheduledErrors = true;

    const server = createServer(async (request, response) => {
      try {
        await generationGate.serve(async () => {
          const servingResult = result;
          const url = new URL(request.url ?? "/", "http://inkpath.local");
          let requestPath: string;
          try {
            requestPath = decodeURIComponent(url.pathname);
          } catch {
            send(response, 400, "Bad request");
            return;
          }
          if (requestPath.includes("\0") || requestPath.includes("\\")) {
            send(response, 400, "Bad request");
            return;
          }

          const basePath = servingResult.site.config.site.basePath;
          const eventPath = `${basePath}/__inkpath/events`;

          if (requestPath === eventPath) {
            response.writeHead(200, {
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
            });
            response.write(": connected\n\n");
            clients.add(response);
            request.on("close", () => clients.delete(response));
            return;
          }

          if (basePath) {
            if (requestPath === basePath) {
              response.writeHead(308, { Location: `${basePath}/` });
              response.end();
              return;
            }
            if (!requestPath.startsWith(`${basePath}/`)) {
              send(response, 404, "Not found");
              return;
            }
            requestPath = requestPath.slice(basePath.length) || "/";
          }

          if (!requestPath.endsWith("/") && !path.posix.extname(requestPath)) {
            response.writeHead(308, { Location: `${basePath}${requestPath}/` });
            response.end();
            return;
          }

          const findOutput = (candidatePath: string) =>
            safeExistingFilePath(servingResult.site.config.outputDir, candidatePath);
          let filePath = await findOutput(requestPath);
          if (!filePath) {
            filePath = await findOutput("/404.html");
            if (!filePath) {
              send(response, 404, "Not found");
              return;
            }
            response.statusCode = 404;
          }

          const extension = path.extname(filePath).toLowerCase();
          response.setHeader(
            "Content-Type",
            mimeTypes.get(extension) ?? "application/octet-stream",
          );
          const immutableAsset =
            requestPath.startsWith("/_inkpath/chunks/") ||
            /^\/_inkpath\/inkpath-[A-Z0-9]+\.js$/.test(requestPath);
          response.setHeader(
            "Cache-Control",
            immutableAsset ? "public, max-age=31536000, immutable" : "no-store",
          );
          if (extension === ".html") {
            const chunks: Buffer[] = [];
            const stream = createReadStream(filePath);
            for await (const chunk of stream)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const html = Buffer.concat(chunks)
              .toString("utf8")
              .replace("</body>", `${reloadScript(eventPath)}</body>`);
            response.end(html);
          } else {
            await pipeStaticFile(filePath, response);
          }
        });
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        send(response, 500, error instanceof Error ? error.message : "Internal error");
      }
    });
    activeServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    console.log(
      `Inkpath is serving http://${options.host}:${options.port}${result.site.config.site.basePath || "/"}`,
    );

    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        void close().then(resolve, reject);
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup or serving failure that initiated cleanup.
    }
    throw error;
  }
}
