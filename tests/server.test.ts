import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { safeExistingFilePath, safeRequestPath, updateWatchedDirectories } from "../src/server.js";

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
