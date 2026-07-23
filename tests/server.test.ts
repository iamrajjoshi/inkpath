import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { configuredWatchDirectories } from "../src/config.js";
import { RebuildScheduler } from "../src/rebuild-scheduler.js";
import {
  attachWatchEventsForServing,
  GeneratedOutputTracker,
  pipeStaticFile,
  recoverWatchedDirectories,
  safeExistingFilePath,
  safeRequestPath,
  ServingGenerationGate,
  startDevServer,
  updateWatchedDirectories,
  waitForWatcherReady,
  WatchEventBuffer,
} from "../src/server.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

test("static path resolution stays inside the generated site", () => {
  const output = path.resolve("/tmp/inkpath-output");
  assert.equal(safeRequestPath(output, "/"), path.join(output, "index.html"));
  assert.equal(safeRequestPath(output, "/guide/"), path.join(output, "guide", "index.html"));
  assert.equal(
    safeRequestPath(output, "/_inkpath/theme.css"),
    path.join(output, "_inkpath", "theme.css"),
  );
  assert.equal(safeRequestPath(output, "/../secret"), undefined);
  assert.equal(safeRequestPath(output, "/.git/config"), undefined);
  assert.equal(safeRequestPath(output, "/guide/.hidden"), undefined);
});

test("serving rejects symbolic links even when their targets are regular files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-server-"));
  const output = path.join(root, "site");
  await mkdir(output);
  await writeFile(path.join(output, "index.html"), "safe");
  await writeFile(path.join(root, "outside.txt"), "secret");
  await symlink(path.join(root, "outside.txt"), path.join(output, "leak.txt"));

  assert.equal(
    await safeExistingFilePath(output, "/"),
    await realpath(path.join(output, "index.html")),
  );
  assert.equal(await safeExistingFilePath(output, "/leak.txt"), undefined);
});

test("static file streaming observes source errors and destroys the destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-server-stream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = new PassThrough();
  destination.resume();

  await assert.rejects(pipeStaticFile(path.join(root, "missing.txt"), destination), {
    code: "ENOENT",
  });
  assert.equal(destination.destroyed, true);
});

test("requests route and open files from one stable build generation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-server-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousOutput = path.join(root, "previous");
  const nextOutput = path.join(root, "next");
  await mkdir(previousOutput);
  await mkdir(nextOutput);
  await writeFile(path.join(previousOutput, "index.html"), "previous", "utf8");
  await writeFile(path.join(nextOutput, "index.html"), "next", "utf8");

  const gate = new ServingGenerationGate();
  const rebuildEntered = deferred();
  const finishRebuild = deferred();
  let generation = { basePath: "/previous", outputDirectory: previousOutput };
  const rebuilding = gate.rebuild(async () => {
    rebuildEntered.resolve();
    await finishRebuild.promise;
    generation = { basePath: "/next", outputDirectory: nextOutput };
  });
  await rebuildEntered.promise;

  let requestSettled = false;
  const request = gate
    .serve(async () => {
      const snapshot = generation;
      return {
        basePath: snapshot.basePath,
        filePath: await safeExistingFilePath(snapshot.outputDirectory, "/"),
      };
    })
    .finally(() => {
      requestSettled = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requestSettled, false, "an active rebuild must finish before routing");

  finishRebuild.resolve();
  await rebuilding;
  assert.deepEqual(await request, {
    basePath: "/next",
    filePath: await realpath(path.join(nextOutput, "index.html")),
  });
});

test("a queued rebuild cannot replace output while a request is opening it", async () => {
  const gate = new ServingGenerationGate();
  const requestEntered = deferred();
  const finishRequest = deferred();
  let generation = "previous";
  const request = gate.serve(async () => {
    const snapshot = generation;
    requestEntered.resolve();
    await finishRequest.promise;
    return snapshot;
  });
  await requestEntered.promise;

  let rebuildStarted = false;
  const rebuild = gate.rebuild(async () => {
    rebuildStarted = true;
    generation = "next";
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rebuildStarted, false);

  finishRequest.resolve();
  assert.equal(await request, "previous");
  await rebuild;
  assert.equal(await gate.serve(async () => generation), "next");
});

test("watch readiness waits for ready and rejects startup errors", async () => {
  const readyEmitter = new EventEmitter();
  const ready = waitForWatcherReady(
    readyEmitter as unknown as Parameters<typeof waitForWatcherReady>[0],
  );
  readyEmitter.emit("ready");
  await ready;
  assert.equal(readyEmitter.listenerCount("error"), 0);

  const failedEmitter = new EventEmitter();
  const failed = waitForWatcherReady(
    failedEmitter as unknown as Parameters<typeof waitForWatcherReady>[0],
  );
  failedEmitter.emit("error", new Error("watch failed"));
  await assert.rejects(failed, /watch failed/);
  assert.equal(failedEmitter.listenerCount("ready"), 0);
});

test("watch events are buffered, deduplicated, and flushed before live scheduling", async () => {
  const buffer = new WatchEventBuffer();
  buffer.add("/project/content/b.md");
  buffer.add("/project/content/a.md");
  buffer.add("/project/content/b.md");
  const added: Array<string | readonly string[]> = [];
  let flushed = false;

  await buffer.attach({
    add(paths) {
      added.push(paths);
    },
    async flush() {
      flushed = true;
    },
  });
  buffer.add("/project/content/c.md");

  assert.deepEqual(added, [
    ["/project/content/a.md", "/project/content/b.md"],
    "/project/content/c.md",
  ]);
  assert.equal(flushed, true);
});

test("failed startup reconciliation keeps last-good serving state recoverable", async () => {
  const buffer = new WatchEventBuffer();
  buffer.add("/project/content/invalid.md");
  const attempts: string[][] = [];
  const reported: unknown[] = [];
  const scheduler = new RebuildScheduler(
    async (changedPaths) => {
      attempts.push([...changedPaths]);
      if (attempts.length === 1) throw new Error("invalid startup edit");
    },
    { debounceMs: 0 },
  );

  await attachWatchEventsForServing(buffer, scheduler, (error) => reported.push(error));
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /invalid startup edit/);

  buffer.add("/project/content/fixed.md");
  await scheduler.flush();
  assert.deepEqual(attempts, [
    ["/project/content/invalid.md"],
    ["/project/content/fixed.md", "/project/content/invalid.md"],
  ]);
  await scheduler.close();
});

test("startup failures close watcher and engine resources", { timeout: 5_000 }, async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-server-startup-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");

  await assert.rejects(
    startDevServer(project, { host: "127.0.0.1", port: 0 }),
    /content directory does not exist/,
  );
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
});

test("dev watcher follows changed content and public directories", () => {
  const added: string[][] = [];
  const removed: string[][] = [];
  const watcher = {
    add(paths: string | string[]) {
      added.push(typeof paths === "string" ? [paths] : paths);
    },
    unwatch(paths: string | string[]) {
      removed.push(typeof paths === "string" ? [paths] : paths);
    },
  };

  const watched = updateWatchedDirectories(
    watcher,
    ["/project/content", "/project/public"],
    ["/project/notes", "/project/assets"],
  );

  assert.deepEqual(watched, ["/project/notes", "/project/assets"]);
  assert.deepEqual(added, [["/project/notes", "/project/assets"]]);
  assert.deepEqual(removed, [["/project/content", "/project/public"]]);
});

test("generated-output filtering forgets a former output root after a successful move", () => {
  const tracker = new GeneratedOutputTracker("/project/site");
  const finish = tracker.begin("/project/dist");

  assert.equal(tracker.contains("/project/site/index.html"), true);
  assert.equal(tracker.contains("/project/dist/index.html"), true);
  assert.equal(
    tracker.contains("/project/site/content/new.md", ["/project/site"]),
    false,
    "a configured source root must take precedence over its former output role",
  );
  finish(true);

  assert.equal(tracker.contains("/project/site/content/new.md"), false);
  assert.equal(tracker.contains("/project/dist/index.html"), true);
});

test("dev watcher keeps a directory when its configured role changes", () => {
  const calls: Array<["add" | "unwatch", string[]]> = [];
  const watcher = {
    add(paths: string | string[]) {
      calls.push(["add", typeof paths === "string" ? [paths] : paths]);
    },
    unwatch(paths: string | string[]) {
      calls.push(["unwatch", typeof paths === "string" ? [paths] : paths]);
    },
  };

  updateWatchedDirectories(
    watcher,
    ["/project/content", "/project/shared"],
    ["/project/shared", "/project/assets"],
  );

  assert.deepEqual(calls, [
    ["add", ["/project/assets"]],
    ["unwatch", ["/project/content"]],
  ]);
});

test("dev watcher retains overlapping recovery roots", () => {
  const calls: Array<["add" | "unwatch", string[]]> = [];
  const watcher = {
    add(paths: string | string[]) {
      calls.push(["add", typeof paths === "string" ? [paths] : paths]);
    },
    unwatch(paths: string | string[]) {
      calls.push(["unwatch", typeof paths === "string" ? [paths] : paths]);
    },
  };

  const watched = updateWatchedDirectories(
    watcher,
    ["/project"],
    ["/project/content", "/project/public"],
  );

  assert.deepEqual(watched, ["/project/content", "/project/public", "/project"]);
  assert.deepEqual(calls, [["add", ["/project/content", "/project/public"]]]);
});

test("dev recovery watches an existing ancestor before configured directories exist", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-watch-recovery-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(
    path.join(project, "inkpath.yaml"),
    "content: future/notes\npublic: future/assets\nsite:\n  logo: missing.svg\n",
    "utf8",
  );
  const calls: Array<["add" | "unwatch", string[]]> = [];
  const watcher = {
    add(paths: string | string[]) {
      calls.push(["add", typeof paths === "string" ? [paths] : paths]);
    },
    unwatch(paths: string | string[]) {
      calls.push(["unwatch", typeof paths === "string" ? [paths] : paths]);
    },
  };
  const canonicalProject = await realpath(project);
  const current = [path.join(canonicalProject, "content"), path.join(canonicalProject, "public")];

  const watched = await recoverWatchedDirectories(watcher, current, project);
  const next = [canonicalProject, ...current];
  assert.deepEqual(watched, next);
  assert.deepEqual(calls, [["add", [canonicalProject]]]);

  const content = path.join(canonicalProject, "future", "notes");
  const publicDirectory = path.join(canonicalProject, "future", "assets");
  await mkdir(content, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  assert.deepEqual(await configuredWatchDirectories(project), [content, publicDirectory]);
});

test("dev recovery watches safe ancestors of configured symlinks and files", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-watch-ancestor-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const linkedParent = path.join(project, "linked");
  const fileParent = path.join(project, "blocked");
  const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-watch-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(linkedParent);
  await mkdir(fileParent);
  try {
    await symlink(external, path.join(linkedParent, "content"), "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  await writeFile(path.join(fileParent, "public"), "not a directory", "utf8");
  await writeFile(
    path.join(project, "inkpath.yaml"),
    "content: linked/content/notes\npublic: blocked/public/assets\n",
    "utf8",
  );
  const calls: Array<["add" | "unwatch", string[]]> = [];
  const watcher = {
    add(paths: string | string[]) {
      calls.push(["add", typeof paths === "string" ? [paths] : paths]);
    },
    unwatch(paths: string | string[]) {
      calls.push(["unwatch", typeof paths === "string" ? [paths] : paths]);
    },
  };
  const canonicalProject = await realpath(project);
  const current = [path.join(canonicalProject, "content"), path.join(canonicalProject, "public")];
  const expected = [path.join(canonicalProject, "linked"), path.join(canonicalProject, "blocked")];

  assert.deepEqual(await recoverWatchedDirectories(watcher, current, project), expected);
  assert.deepEqual(calls, [
    ["add", expected],
    ["unwatch", current],
  ]);
});
