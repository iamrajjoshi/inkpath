import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceOutputFiles } from "../src/output-transaction.js";

async function temporaryOutput(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-output-transaction-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const output = path.join(root, "site");
  await mkdir(output);
  return output;
}

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoScratch(output: string): Promise<void> {
  const prefix = `.${path.basename(output)}.inkpath-transaction-`;
  assert.deepEqual(
    (await readdir(path.dirname(output))).filter((entry) => entry.startsWith(prefix)),
    [],
  );
}

test("publishes replacements and new nested output files", async (t) => {
  const output = await temporaryOutput(t);
  await writeFile(path.join(output, "index.html"), "old home", "utf8");
  await writeFile(path.join(output, "unchanged.txt"), "keep me", "utf8");

  await replaceOutputFiles(output, [
    { relativePath: "guides/deep/index.html", contents: "nested page" },
    { relativePath: "index.html", contents: "new home" },
  ]);

  assert.equal(await readFile(path.join(output, "index.html"), "utf8"), "new home");
  assert.equal(
    await readFile(path.join(output, "guides", "deep", "index.html"), "utf8"),
    "nested page",
  );
  assert.equal(await readFile(path.join(output, "unchanged.txt"), "utf8"), "keep me");
  await assertNoScratch(output);
});

test("publishes binary files byte-for-byte", async (t) => {
  const output = await temporaryOutput(t);
  const contents = Buffer.from([0, 255, 1, 128, 10]);

  await replaceOutputFiles(output, [{ relativePath: "_content/image.bin", contents }]);

  assert.deepEqual(await readFile(path.join(output, "_content", "image.bin")), contents);
  await assertNoScratch(output);
});

test("removes stale output files without disturbing neighboring files", async (t) => {
  const output = await temporaryOutput(t);
  await mkdir(path.join(output, "stale"));
  await writeFile(path.join(output, "stale", "index.html"), "stale", "utf8");
  await writeFile(path.join(output, "stale", "asset.txt"), "neighbor", "utf8");

  await replaceOutputFiles(output, [{ relativePath: "stale/index.html" }]);

  assert.equal(await exists(path.join(output, "stale", "index.html")), false);
  assert.equal(await readFile(path.join(output, "stale", "asset.txt"), "utf8"), "neighbor");
  await assertNoScratch(output);
});

test("rejects unsafe and conflicting output paths before publishing", async (t) => {
  const output = await temporaryOutput(t);
  const original = path.join(output, "index.html");
  await writeFile(original, "original", "utf8");

  for (const relativePath of [
    "/absolute.html",
    "../escape.html",
    "nested/./escape.html",
    "nested//escape.html",
    "nested\\escape.html",
    ".site.inkpath-transaction-owned/staged/escape.html",
  ]) {
    await assert.rejects(
      replaceOutputFiles(output, [
        { relativePath: "index.html", contents: "must not publish" },
        { relativePath, contents: "unsafe" },
      ]),
    );
    assert.equal(await readFile(original, "utf8"), "original");
  }

  await assert.rejects(
    replaceOutputFiles(output, [
      { relativePath: "same.html", contents: "first" },
      { relativePath: "same.html", contents: "second" },
    ]),
    /duplicate output path: same\.html/,
  );
  await assert.rejects(
    replaceOutputFiles(output, [
      { relativePath: "route", contents: "file" },
      { relativePath: "route/index.html", contents: "child" },
    ]),
    /output paths conflict/,
  );
  await assertNoScratch(output);
});

test("rejects symbolic-link targets and ancestors", async (t) => {
  const output = await temporaryOutput(t);
  const external = path.join(path.dirname(output), "external");
  await mkdir(external);
  const externalFile = path.join(external, "outside.html");
  await writeFile(externalFile, "outside", "utf8");
  await symlink(externalFile, path.join(output, "linked-file.html"));
  await symlink(external, path.join(output, "linked-directory"), "dir");

  await assert.rejects(
    replaceOutputFiles(output, [{ relativePath: "linked-file.html", contents: "overwrite" }]),
    /must not contain symbolic links/,
  );
  await assert.rejects(
    replaceOutputFiles(output, [
      { relativePath: "linked-directory/escaped.html", contents: "escape" },
    ]),
    /must not contain symbolic links/,
  );

  assert.equal(await readFile(externalFile, "utf8"), "outside");
  assert.equal(await exists(path.join(external, "escaped.html")), false);
  await assertNoScratch(output);
});

test("rolls back prior targets byte-for-byte after a mid-commit failure", async (t) => {
  const output = await temporaryOutput(t);
  const original = Buffer.from([0, 1, 2, 3, 255, 10]);
  await writeFile(path.join(output, "a-existing.bin"), original);
  await writeFile(path.join(output, "z-blocked"), "regular-file ancestor", "utf8");

  await assert.rejects(
    replaceOutputFiles(output, [
      { relativePath: "z-blocked/index.html", contents: "cannot install" },
      { relativePath: "a-existing.bin", contents: "replacement" },
      { relativePath: "b-new/index.html", contents: "new route" },
    ]),
    /failed to update output file z-blocked\/index\.html/,
  );

  assert.deepEqual(await readFile(path.join(output, "a-existing.bin")), original);
  assert.equal(await exists(path.join(output, "b-new", "index.html")), false);
  assert.equal(await exists(path.join(output, "b-new")), false);
  assert.equal(await readFile(path.join(output, "z-blocked"), "utf8"), "regular-file ancestor");
  await assertNoScratch(output);
});
