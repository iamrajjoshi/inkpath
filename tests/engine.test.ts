import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";
import { createBuildEngine } from "../src/engine.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

async function fixture(t: test.TestContext): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-engine-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await cp(fixtureRoot, project, { recursive: true });
  return project;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function outputHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        hashes.set(
          path.relative(root, entryPath).split(path.sep).join("/"),
          createHash("sha256")
            .update(await readFile(entryPath))
            .digest("hex"),
        );
      }
    }
  };
  await visit(root);
  return hashes;
}

test("no-op and body rebuilds perform bounded incremental work", async (t) => {
  const project = await fixture(t);
  const output = path.join(project, "site");
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const pageOutput = path.join(output, "foundations", "first", "index.html");
  const unrelatedOutput = path.join(output, "foundations", "second", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());

  await engine.build({ profile: true });
  const before = await outputHashes(output);
  const unrelatedBefore = await readFile(unrelatedOutput);

  const noOp = await engine.rebuild([], { profile: true });
  assert.deepEqual(noOp.incremental, {
    changedPaths: 0,
    mode: "noop",
    parsedPages: 0,
    renderedDocuments: 0,
    renderedMarkdown: 0,
    writtenFiles: 0,
  });
  assert.deepEqual(await outputHashes(output), before);

  const unchanged = await engine.rebuild([sourceRelative], { profile: true });
  assert.deepEqual(unchanged.incremental, {
    changedPaths: 1,
    mode: "noop",
    parsedPages: 1,
    renderedDocuments: 0,
    renderedMarkdown: 0,
    writtenFiles: 0,
  });
  assert.ok((unchanged.timings?.contentMs ?? 0) > 0);
  assert.deepEqual(await outputHashes(output), before);

  await writeFile(
    source,
    `${(await readFile(source, "utf8")).trimEnd()}\n\nIncremental body marker.\n`,
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.deepEqual(rebuilt.incremental, {
    changedPaths: 1,
    mode: "partial",
    parsedPages: 1,
    renderedDocuments: 1,
    renderedMarkdown: 1,
    writtenFiles: 1,
  });
  assert.match(await readFile(pageOutput, "utf8"), /Incremental body marker\./);
  assert.deepEqual(await readFile(unrelatedOutput), unrelatedBefore);

  const incrementalHashes = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(incrementalHashes, await outputHashes(output));
});

test("link edits update backlinks and orphan discovery without scanning other Markdown", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const original = await readFile(source, "utf8");
  const updated = original
    .replace("[second note](02-second.md#second-section)", "second note")
    .replace("[validated link](02-second.md#second-section)", "validated link");
  assert.notEqual(updated, original);
  await writeFile(source, updated, "utf8");

  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(rebuilt.incremental?.mode, "partial");
  assert.equal(rebuilt.incremental?.parsedPages, 1);
  assert.equal(rebuilt.incremental?.renderedMarkdown, 1);
  assert.equal(rebuilt.incremental?.renderedDocuments, 2);
  assert.equal(rebuilt.incremental?.writtenFiles, 3);
  assert.equal(rebuilt.orphans, 2);
  assert.doesNotMatch(
    await readFile(path.join(output, "foundations", "second", "index.html"), "utf8"),
    /Linked from/,
  );
  assert.match(
    await readFile(path.join(output, "_inkpath", "orphans.json"), "utf8"),
    /Second note/,
  );

  const incrementalHashes = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(incrementalHashes, await outputHashes(output));
});

test("incremental validation matches clean builds for empty anchor fragments", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  await writeFile(source, `${await readFile(source, "utf8")}\n\n[Top](#)\n`, "utf8");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await writeFile(source, `${await readFile(source, "utf8")}\nBody update.\n`, "utf8");
  const rebuilt = await engine.rebuild([sourceRelative]);
  assert.equal(rebuilt.incremental?.mode, "partial");

  const incrementalHashes = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(incrementalHashes, await outputHashes(output));
});

test("failed incremental validation preserves output and engine state, then recovers", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const goodSource = await readFile(source, "utf8");
  const goodOutput = await outputHashes(output);

  await writeFile(source, goodSource.replaceAll("#second-section", "#missing-section"), "utf8");
  await assert.rejects(
    engine.rebuild([sourceRelative]),
    /missing anchor #missing-section in 01-foundations\/02-second\.md/,
  );
  assert.deepEqual(await outputHashes(output), goodOutput);

  await writeFile(source, `${goodSource.trimEnd()}\n\nRecovered incrementally.\n`, "utf8");
  const recovered = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(recovered.incremental?.mode, "partial");
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /Recovered incrementally\./,
  );
});

test("structural route edits reconcile safely and remove stale output", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const oldOutput = path.join(output, "foundations", "first", "index.html");
  const nextOutput = path.join(output, "foundations", "renamed-first", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const original = await readFile(source, "utf8");
  await writeFile(source, original.replace(/^---\n/, "---\nslug: renamed-first\n"), "utf8");
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(rebuilt.incremental?.mode, "partial");
  assert.equal(await exists(oldOutput), false);
  assert.equal(await exists(nextOutput), true);
});

test("section route edits move descendants and rewrite incoming links incrementally", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/INDEX.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("slug: foundations", "slug: essentials"),
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(rebuilt.incremental?.mode, "partial");
  assert.equal(await exists(path.join(output, "foundations", "first", "index.html")), false);
  assert.equal(await exists(path.join(output, "essentials", "first", "index.html")), true);
  assert.match(
    await readFile(path.join(output, "essentials", "first", "index.html"), "utf8"),
    /href="\/docs\/essentials\/second\/#second-section"/,
  );

  const incremental = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(await outputHashes(output), incremental);
});

test("a write after check state creates a complete output tree", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.check();
  assert.equal(await exists(output), false);

  await writeFile(
    source,
    `${(await readFile(source, "utf8")).trimEnd()}\n\nWritten after check.\n`,
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(rebuilt.incremental?.mode, "full");
  for (const relativePath of [
    "404.html",
    "_inkpath/orphans.json",
    "_inkpath/theme.css",
    "foundations/first/index.html",
    "index.html",
  ]) {
    assert.equal(await exists(path.join(output, relativePath)), true, relativePath);
  }
});

test("the incremental reader rejects a source replaced by a symbolic link", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const external = path.join(project, "outside.md");
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const goodOutput = await outputHashes(output);
  await writeFile(external, "---\ntitle: Outside\n---\n\nExternal content.\n", "utf8");
  await rm(source);
  try {
    await symlink(external, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(engine.rebuild([sourceRelative]), /content cannot contain symbolic links/);
  assert.deepEqual(await outputHashes(output), goodOutput);
});

test("changing or clearing the build commit invalidates every document", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build({ commitSha: "abcdef123456" });
  assert.match(await readFile(path.join(output, "index.html"), "utf8"), /abcdef1/);

  const changedCommit = await engine.rebuild([], {
    commitSha: "fedcba654321",
    profile: true,
  });
  assert.equal(changedCommit.incremental?.mode, "full");
  assert.match(await readFile(path.join(output, "index.html"), "utf8"), /fedcba6/);
  const changedCommitHashes = await outputHashes(output);
  await buildSite(project, { commitSha: "fedcba654321" });
  assert.deepEqual(changedCommitHashes, await outputHashes(output));

  await writeFile(
    source,
    `${(await readFile(source, "utf8")).trimEnd()}\n\nCommit cleared.\n`,
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assert.equal(rebuilt.incremental?.mode, "full");
  assert.doesNotMatch(await readFile(path.join(output, "index.html"), "utf8"), /abcdef1/);
  const rebuiltHashes = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(rebuiltHashes, await outputHashes(output));
});

test("incremental asset validation rejects symbolic-link ancestors", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const assetDirectory = path.join(project, "content", "01-foundations", "assets");
  const externalDirectory = path.join(project, "external-assets");
  const output = path.join(project, "site");
  await mkdir(assetDirectory);
  await writeFile(path.join(assetDirectory, "placeholder.txt"), "safe", "utf8");
  await mkdir(externalDirectory);
  await writeFile(path.join(externalDirectory, "secret.txt"), "outside", "utf8");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const goodOutput = await outputHashes(output);

  await rm(assetDirectory, { recursive: true });
  try {
    await symlink(externalDirectory, assetDirectory, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("(sample.txt)", "(assets/secret.txt)"),
    "utf8",
  );

  await assert.rejects(
    engine.rebuild([sourceRelative]),
    /local asset must be a regular file: 01-foundations\/assets\/secret\.txt/,
  );
  assert.deepEqual(await outputHashes(output), goodOutput);
});
