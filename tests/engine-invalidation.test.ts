import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";
import { createBuildEngine } from "../src/engine.js";
import type { BuildResult } from "../src/types.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

async function fixture(t: test.TestContext): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-invalidation-"));
  t.after(() => rm(project, { force: true, recursive: true }));
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

async function filesystemIsCaseSensitive(directory: string): Promise<boolean> {
  const lower = path.join(directory, "inkpath-case-sensitivity-probe");
  const upper = path.join(directory, "INKPATH-CASE-SENSITIVITY-PROBE");
  await writeFile(lower, "probe\n", "utf8");
  try {
    return !(await exists(upper));
  } finally {
    await rm(lower, { force: true });
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

async function assertMatchesCleanBuild(project: string): Promise<void> {
  const output = path.join(project, "site");
  const incremental = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(await outputHashes(output), incremental);
}

function assertMode(
  result: BuildResult,
  mode: "clean" | "full" | "noop" | "partial",
  changedPaths: number,
): void {
  assert.equal(result.incremental?.mode, mode);
  assert.equal(result.incremental?.changedPaths, changedPaths);
}

test("target anchor failures preserve output and cached state before recovery", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/02-second.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const pageOutput = path.join(output, "foundations", "second", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());

  await engine.build();
  const goodSource = await readFile(source, "utf8");
  const goodOutput = await outputHashes(output);
  const invalidSource = goodSource.replace("## Second section", "## Renamed section");
  assert.notEqual(invalidSource, goodSource);
  await writeFile(source, invalidSource, "utf8");

  await assert.rejects(
    engine.rebuild([sourceRelative]),
    /01-first\.md: missing anchor #second-section in 01-foundations\/02-second\.md/,
  );
  assert.deepEqual(await outputHashes(output), goodOutput);

  const noOp = await engine.rebuild([]);
  assertMode(noOp, "noop", 0);
  assert.deepEqual(await outputHashes(output), goodOutput);

  await writeFile(
    source,
    goodSource.replace(
      "The linked section has a stable ID.",
      "The linked section recovered with a stable ID.",
    ),
    "utf8",
  );
  const recovered = await engine.rebuild([sourceRelative]);
  assert.deepEqual(recovered.incremental, {
    changedPaths: 1,
    mode: "partial",
    parsedPages: 1,
    renderedDocuments: 1,
    renderedMarkdown: 1,
    writtenFiles: 1,
  });
  assert.match(await readFile(pageOutput, "utf8"), /recovered with a stable ID/);
  await assertMatchesCleanBuild(project);
});

test("body-derived summary edits update the parent listing and both feeds", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const original = await readFile(source, "utf8");
  const updated = original.replace(
    "This first sentence becomes the automatic summary.",
    "The refreshed summary now reaches every discovery surface.",
  );
  assert.notEqual(updated, original);
  await writeFile(source, updated, "utf8");

  const rebuilt = await engine.rebuild([sourceRelative]);
  assert.deepEqual(rebuilt.incremental, {
    changedPaths: 1,
    mode: "partial",
    parsedPages: 1,
    renderedDocuments: 2,
    renderedMarkdown: 1,
    writtenFiles: 4,
  });
  for (const relativeOutput of [
    "foundations/first/index.html",
    "foundations/index.html",
    "rss.xml",
    "atom.xml",
  ]) {
    assert.match(
      await readFile(path.join(output, relativeOutput), "utf8"),
      /The refreshed summary now reaches every discovery surface\./,
      relativeOutput,
    );
  }
  await assertMatchesCleanBuild(project);
});

test("link retargeting updates both backlink consumers and a stable-count orphan report", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const thirdSource = path.join(project, "content", "01-foundations", "03-third.md");
  const output = path.join(project, "site");
  await writeFile(
    thirdSource,
    "---\ntitle: Third note\norder: 3\n---\n\n## Third section\n\nA third target.\n",
    "utf8",
  );
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  const initial = await engine.build();
  assert.equal(initial.orphans, 2);

  const original = await readFile(source, "utf8");
  const updated = original.replaceAll("02-second.md#second-section", "03-third.md#third-section");
  assert.notEqual(updated, original);
  await writeFile(source, updated, "utf8");

  const rebuilt = await engine.rebuild([sourceRelative]);
  assert.deepEqual(rebuilt.incremental, {
    changedPaths: 1,
    mode: "partial",
    parsedPages: 1,
    renderedDocuments: 3,
    renderedMarkdown: 1,
    writtenFiles: 4,
  });
  assert.equal(rebuilt.orphans, 2);
  assert.doesNotMatch(
    await readFile(path.join(output, "foundations", "second", "index.html"), "utf8"),
    /class="backlinks"/,
  );
  assert.match(
    await readFile(path.join(output, "foundations", "third", "index.html"), "utf8"),
    /class="backlinks"[\s\S]*First note/,
  );
  const orphanReport = await readFile(path.join(output, "_inkpath", "orphans.json"), "utf8");
  assert.match(orphanReport, /"title": "Second note"/);
  assert.doesNotMatch(orphanReport, /"title": "Third note"/);
  await assertMatchesCleanBuild(project);
});

test("missing local assets preserve output and recover through a full asset rebuild", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const assetRelative = "content/01-foundations/recovered.txt";
  const asset = path.join(project, assetRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const goodOutput = await outputHashes(output);

  const original = await readFile(source, "utf8");
  const missingAssetSource = original.replace("sample.txt", "recovered.txt");
  assert.notEqual(missingAssetSource, original);
  await writeFile(source, missingAssetSource, "utf8");
  await assert.rejects(
    engine.rebuild([sourceRelative]),
    /01-first\.md: missing local asset 01-foundations\/recovered\.txt/,
  );
  assert.deepEqual(await outputHashes(output), goodOutput);

  await writeFile(asset, "recovered local asset\n", "utf8");
  const recovered = await engine.rebuild([assetRelative]);
  assertMode(recovered, "full", 1);
  assert.equal(
    await readFile(path.join(output, "_content", "01-foundations", "recovered.txt"), "utf8"),
    "recovered local asset\n",
  );
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /_content\/01-foundations\/recovered\.txt/,
  );
  await assertMatchesCleanBuild(project);
});

test("a Markdown edit publishes a newly referenced asset in the same transaction", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const asset = path.join(project, "content", "01-foundations", "new-image.bin");
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const binary = Buffer.from([0, 255, 10, 128]);
  await writeFile(asset, binary);
  await writeFile(
    source,
    `${await readFile(source, "utf8")}\n\n![New asset](new-image.bin)\n`,
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative]);
  assertMode(rebuilt, "partial", 1);
  assert.deepEqual(
    await readFile(path.join(output, "_content", "01-foundations", "new-image.bin")),
    binary,
  );
  await assertMatchesCleanBuild(project);
});

test("title and order edits stay bounded while draft edits fall back", async (t) => {
  await t.test("title updates every metadata consumer without rerendering Markdown", async (t) => {
    const project = await fixture(t);
    const sourceRelative = "content/01-foundations/01-first.md";
    const source = path.join(project, sourceRelative);
    const output = path.join(project, "site");
    const engine = createBuildEngine(project);
    t.after(() => engine.close());
    await engine.build();

    await writeFile(
      source,
      (await readFile(source, "utf8")).replace("title: First note", "title: Renamed note"),
      "utf8",
    );
    const rebuilt = await engine.rebuild([sourceRelative]);
    assert.deepEqual(rebuilt.incremental, {
      changedPaths: 1,
      mode: "partial",
      parsedPages: 1,
      renderedDocuments: 3,
      renderedMarkdown: 0,
      writtenFiles: 6,
    });
    const parent = await readFile(path.join(output, "foundations", "index.html"), "utf8");
    assert.match(parent, /Renamed note/);
    assert.doesNotMatch(parent, />First note</);
    assert.match(
      await readFile(path.join(output, "foundations", "second", "index.html"), "utf8"),
      /class="backlinks"[\s\S]*Renamed note/,
    );
    assert.match(await readFile(path.join(output, "rss.xml"), "utf8"), /Renamed note/);
    assert.match(await readFile(path.join(output, "atom.xml"), "utf8"), /Renamed note/);
    assert.match(
      await readFile(path.join(output, "_inkpath", "orphans.json"), "utf8"),
      /"title": "Renamed note"/,
    );
    await assertMatchesCleanBuild(project);
  });

  await t.test("order updates listing and pagination order", async (t) => {
    const project = await fixture(t);
    const sourceRelative = "content/01-foundations/01-first.md";
    const source = path.join(project, sourceRelative);
    await writeFile(
      path.join(project, "content", "01-foundations", "03-third.md"),
      "---\ntitle: Third note\norder: 3\n---\n\n## Third section\n\nA third sibling.\n",
      "utf8",
    );
    const output = path.join(project, "site");
    const engine = createBuildEngine(project);
    t.after(() => engine.close());
    await engine.build();

    await writeFile(
      source,
      (await readFile(source, "utf8")).replace("order: 1", "order: 4"),
      "utf8",
    );
    const rebuilt = await engine.rebuild([sourceRelative]);
    assert.deepEqual(rebuilt.incremental, {
      changedPaths: 1,
      mode: "partial",
      parsedPages: 1,
      renderedDocuments: 4,
      renderedMarkdown: 0,
      writtenFiles: 4,
    });
    const parent = await readFile(path.join(output, "foundations", "index.html"), "utf8");
    assert.ok(parent.indexOf("Second note") < parent.indexOf("First note"));
    assert.ok(parent.indexOf("Third note") < parent.indexOf("First note"));
    assert.match(
      await readFile(path.join(output, "foundations", "second", "index.html"), "utf8"),
      /rel="next"[\s\S]*Third note/,
    );
    assert.match(
      await readFile(path.join(output, "foundations", "third", "index.html"), "utf8"),
      /rel="prev"[\s\S]*Second note[\s\S]*rel="next"[\s\S]*First note/,
    );
    await assertMatchesCleanBuild(project);
  });

  await t.test("a title edit mixed with other frontmatter reconciles incrementally", async (t) => {
    const project = await fixture(t);
    const sourceRelative = "content/01-foundations/01-first.md";
    const source = path.join(project, sourceRelative);
    const engine = createBuildEngine(project);
    t.after(() => engine.close());
    await engine.build();

    await writeFile(
      source,
      (await readFile(source, "utf8"))
        .replace("title: First note", "title: Renamed note")
        .replace("identifier: F1", "identifier: F1-updated"),
      "utf8",
    );
    const rebuilt = await engine.rebuild([sourceRelative]);
    assertMode(rebuilt, "partial", 1);
    await assertMatchesCleanBuild(project);
  });

  await t.test("draft removes stale output and navigation", async (t) => {
    const project = await fixture(t);
    const sourceRelative = "content/01-foundations/01-first.md";
    const source = path.join(project, sourceRelative);
    const output = path.join(project, "site");
    const staleOutput = path.join(output, "foundations", "first", "index.html");
    const engine = createBuildEngine(project);
    t.after(() => engine.close());
    await engine.build();

    await writeFile(
      source,
      (await readFile(source, "utf8")).replace(/^---\n/, "---\ndraft: true\n"),
      "utf8",
    );
    const rebuilt = await engine.rebuild([sourceRelative]);
    assertMode(rebuilt, "full", 1);
    assert.equal(await exists(staleOutput), false);
    assert.doesNotMatch(
      await readFile(path.join(output, "foundations", "index.html"), "utf8"),
      /First note/,
    );
    await assertMatchesCleanBuild(project);
  });
});

test("a home title edit updates the derived site title incrementally", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/INDEX.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("title: Fixture notes", "title: Renamed notes"),
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative]);
  assertMode(rebuilt, "partial", 1);
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /First note · Renamed notes/,
  );
  assert.match(await readFile(path.join(output, "404.html"), "utf8"), /Not found · Renamed notes/);
  await assertMatchesCleanBuild(project);
});

test("file add, rename, and delete reconcile the graph without stale routes", async (t) => {
  const project = await fixture(t);
  const output = path.join(project, "site");
  const addedRelative = "content/01-foundations/03-added.md";
  const renamedRelative = "content/01-foundations/04-renamed.md";
  const addedSource = path.join(project, addedRelative);
  const renamedSource = path.join(project, renamedRelative);
  const addedOutput = path.join(output, "foundations", "added", "index.html");
  const renamedOutput = path.join(output, "foundations", "renamed", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await writeFile(addedSource, "---\ntitle: Added note\n---\n\nAdded body.\n", "utf8");
  const added = await engine.rebuild([addedRelative]);
  assertMode(added, "partial", 1);
  assert.match(await readFile(addedOutput, "utf8"), /Added body\./);
  await assertMatchesCleanBuild(project);

  await rename(addedSource, renamedSource);
  const renamed = await engine.rebuild([addedRelative, renamedRelative]);
  assertMode(renamed, "partial", 2);
  assert.equal(await exists(addedOutput), false);
  assert.match(await readFile(renamedOutput, "utf8"), /Added body\./);
  await assertMatchesCleanBuild(project);

  await rm(renamedSource);
  const deleted = await engine.rebuild([renamedRelative]);
  assertMode(deleted, "partial", 1);
  assert.equal(await exists(renamedOutput), false);
  await assertMatchesCleanBuild(project);
});

test("hidden Markdown path segments remain excluded during reconciliation", async (t) => {
  const project = await fixture(t);
  const output = path.join(project, "site");
  const hiddenDirectory = path.join(project, "content", ".hidden");
  const hiddenFile = path.join(project, "content", ".secret.md");
  const nestedHiddenFile = path.join(hiddenDirectory, "secret.md");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const originalOutput = await outputHashes(output);

  await mkdir(hiddenDirectory);
  await Promise.all([
    writeFile(hiddenFile, "---\ntitle: Hidden root note\n---\n\nHidden.\n", "utf8"),
    writeFile(nestedHiddenFile, "---\ntitle: Hidden nested note\n---\n\nHidden.\n", "utf8"),
  ]);

  const rebuilt = await engine.rebuild(["content/.secret.md", "content/.hidden/secret.md"]);
  assertMode(rebuilt, "partial", 2);
  assert.equal(rebuilt.site.pageBySource.has(".secret.md"), false);
  assert.equal(rebuilt.site.pageBySource.has(".hidden/secret.md"), false);
  assert.deepEqual(await outputHashes(output), originalOutput);
  await assertMatchesCleanBuild(project);
});

test("case-only renames reconcile to the filesystem spelling", async (t) => {
  const project = await fixture(t);
  if (await filesystemIsCaseSensitive(project)) {
    t.skip("case-only rename behavior requires a case-insensitive filesystem");
    return;
  }

  const oldRelative = "content/01-foundations/01-first.md";
  const nextRelative = "content/01-foundations/01-FIRST.md";
  const oldSource = path.join(project, oldRelative);
  const nextSource = path.join(project, nextRelative);
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await rename(oldSource, nextSource);
  const rebuilt = await engine.rebuild([oldRelative, nextRelative]);
  assertMode(rebuilt, "partial", 2);
  assert.equal(rebuilt.site.pageBySource.has("01-foundations/01-first.md"), false);
  assert.equal(rebuilt.site.pageBySource.has("01-foundations/01-FIRST.md"), true);
  await assertMatchesCleanBuild(project);
});

test("case-only renames reconcile when only one filesystem alias is reported", async (t) => {
  for (const reportedAlias of ["old", "new"] as const) {
    await t.test(`${reportedAlias} alias`, async (aliasTest) => {
      const project = await fixture(aliasTest);
      if (await filesystemIsCaseSensitive(project)) {
        aliasTest.skip("case-only rename behavior requires a case-insensitive filesystem");
        return;
      }

      const oldRelative = "content/01-foundations/01-first.md";
      const nextRelative = "content/01-foundations/01-FIRST.md";
      const oldSource = path.join(project, oldRelative);
      const nextSource = path.join(project, nextRelative);
      const engine = createBuildEngine(project);
      aliasTest.after(() => engine.close());
      await engine.build();

      await rename(oldSource, nextSource);
      const rebuilt = await engine.rebuild([reportedAlias === "old" ? oldRelative : nextRelative]);
      assertMode(rebuilt, "partial", 1);
      assert.equal(rebuilt.site.pageBySource.has("01-foundations/01-first.md"), false);
      assert.equal(rebuilt.site.pageBySource.has("01-foundations/01-FIRST.md"), true);
      await assertMatchesCleanBuild(project);
    });
  }
});

test("removing a generated route restores a shadowed public file", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const publicOutput = path.join(project, "public", "foundations", "first", "index.html");
  const output = path.join(project, "site");
  const oldOutput = path.join(output, "foundations", "first", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());

  await mkdir(path.dirname(publicOutput), { recursive: true });
  await writeFile(publicOutput, "PUBLIC SHADOW\n", "utf8");
  await engine.build();
  assert.doesNotMatch(await readFile(oldOutput, "utf8"), /PUBLIC SHADOW/);

  await writeFile(
    source,
    (await readFile(source, "utf8")).replace(/^---\n/, "---\nslug: moved-first\n"),
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative]);
  assertMode(rebuilt, "partial", 1);
  assert.equal(await readFile(oldOutput, "utf8"), "PUBLIC SHADOW\n");
  await assertMatchesCleanBuild(project);
});

test("reconciliation preserves clean depth-first source ordering", async (t) => {
  const project = await fixture(t);
  const prefixedSource = path.join(project, "content", "01-foundations.md");
  const addedRelative = "content/01-foundations/03-added.md";
  const engine = createBuildEngine(project);
  t.after(() => engine.close());

  await writeFile(
    prefixedSource,
    "---\ntitle: Root foundations peer\nslug: root-foundations-peer\n---\n\n[Second](01-foundations/02-second.md#second-section)\n",
    "utf8",
  );
  await engine.build();
  await writeFile(
    path.join(project, addedRelative),
    "---\ntitle: Added note\n---\n\nAdded body.\n",
    "utf8",
  );

  const rebuilt = await engine.rebuild([addedRelative]);
  assertMode(rebuilt, "partial", 1);
  await assertMatchesCleanBuild(project);
});

test("a newly added page publishes its referenced asset in the same transaction", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/03-added.md";
  const source = path.join(project, sourceRelative);
  const asset = path.join(project, "content", "01-foundations", "added-image.bin");
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const binary = Buffer.from([222, 173, 190, 239]);
  await writeFile(asset, binary);
  await writeFile(
    source,
    "---\ntitle: Added note\n---\n\n![Added asset](added-image.bin)\n",
    "utf8",
  );

  const rebuilt = await engine.rebuild([sourceRelative]);
  assertMode(rebuilt, "partial", 1);
  assert.deepEqual(
    await readFile(path.join(output, "_content", "01-foundations", "added-image.bin")),
    binary,
  );
  await assertMatchesCleanBuild(project);
});

test("multiple Markdown edits reconcile in one transaction", async (t) => {
  const project = await fixture(t);
  const firstRelative = "content/01-foundations/01-first.md";
  const secondRelative = "content/01-foundations/02-second.md";
  const firstSource = path.join(project, firstRelative);
  const secondSource = path.join(project, secondRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await Promise.all([
    writeFile(
      firstSource,
      (await readFile(firstSource, "utf8")).replace(
        "This first sentence becomes the automatic summary.",
        "The first page changed in a shared editor save.",
      ),
      "utf8",
    ),
    writeFile(
      secondSource,
      (await readFile(secondSource, "utf8")).replace(
        "The linked section has a stable ID.",
        "The second page changed in the same editor save.",
      ),
      "utf8",
    ),
  ]);

  const rebuilt = await engine.rebuild([secondRelative, firstRelative], { profile: true });
  assertMode(rebuilt, "partial", 2);
  assert.equal(rebuilt.incremental?.parsedPages, 2);
  assert.equal(rebuilt.incremental?.renderedMarkdown, 2);
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /first page changed in a shared editor save/,
  );
  assert.match(
    await readFile(path.join(output, "foundations", "second", "index.html"), "utf8"),
    /second page changed in the same editor save/,
  );
  await assertMatchesCleanBuild(project);
});

test("a deletion and its incoming-link edit reconcile together", async (t) => {
  const project = await fixture(t);
  const firstRelative = "content/01-foundations/01-first.md";
  const secondRelative = "content/01-foundations/02-second.md";
  const firstSource = path.join(project, firstRelative);
  const secondSource = path.join(project, secondRelative);
  const output = path.join(project, "site");
  const secondOutput = path.join(output, "foundations", "second", "index.html");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();
  const goodOutput = await outputHashes(output);

  await rm(secondSource);
  await assert.rejects(
    engine.rebuild([secondRelative]),
    /01-first\.md: missing Markdown link target 02-second\.md#second-section/,
  );
  assert.deepEqual(await outputHashes(output), goodOutput);

  await writeFile(
    firstSource,
    (await readFile(firstSource, "utf8")).replaceAll(
      "02-second.md#second-section",
      "https://example.com/replacement",
    ),
    "utf8",
  );

  const rebuilt = await engine.rebuild([secondRelative, firstRelative]);
  assertMode(rebuilt, "partial", 2);
  assert.equal(await exists(secondOutput), false);
  assert.doesNotMatch(
    await readFile(path.join(output, "foundations", "index.html"), "utf8"),
    /Second note/,
  );
  await assertMatchesCleanBuild(project);
});

test("a removed published tree forces a complete rebuild before a page edit", async (t) => {
  const project = await fixture(t);
  const sourceRelative = "content/01-foundations/01-first.md";
  const source = path.join(project, sourceRelative);
  const output = path.join(project, "site");
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  await rm(output, { force: true, recursive: true });
  await writeFile(
    source,
    `${(await readFile(source, "utf8")).trimEnd()}\n\nRebuilt after output removal.\n`,
    "utf8",
  );
  const rebuilt = await engine.rebuild([sourceRelative], { profile: true });
  assertMode(rebuilt, "full", 1);
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /Rebuilt after output removal\./,
  );
  for (const coreOutput of ["index.html", "404.html", "_inkpath/orphans.json"]) {
    assert.equal(await exists(path.join(output, coreOutput)), true, coreOutput);
  }
  await assertMatchesCleanBuild(project);
});

test("public and config changes rebuild fully while invalid config preserves the last good site", async (t) => {
  const project = await fixture(t);
  const output = path.join(project, "site");
  const publicRelative = "public/favicon.svg";
  const publicSource = path.join(project, publicRelative);
  const configRelative = "inkpath.yaml";
  const configSource = path.join(project, configRelative);
  const engine = createBuildEngine(project);
  t.after(() => engine.close());
  await engine.build();

  const publicMarker = "<!-- incrementally recopied -->";
  await writeFile(
    publicSource,
    `${(await readFile(publicSource, "utf8")).trimEnd()}${publicMarker}\n`,
    "utf8",
  );
  const publicRebuild = await engine.rebuild([publicRelative]);
  assertMode(publicRebuild, "full", 1);
  assert.match(await readFile(path.join(output, "favicon.svg"), "utf8"), /incrementally recopied/);
  await assertMatchesCleanBuild(project);

  const originalConfig = await readFile(configSource, "utf8");
  const themedConfig = `${originalConfig.trimEnd()}\ntheme:\n  accent: "#123456"\n`;
  await writeFile(configSource, themedConfig, "utf8");
  const configRebuild = await engine.rebuild([configRelative]);
  assertMode(configRebuild, "full", 1);
  assert.match(
    await readFile(path.join(output, "_inkpath", "theme.css"), "utf8"),
    /--willow: #123456/,
  );
  await assertMatchesCleanBuild(project);

  const goodOutput = await outputHashes(output);
  await writeFile(configSource, themedConfig.replace("  math: true", '  math: "invalid"'), "utf8");
  await assert.rejects(engine.rebuild([configRelative]), /markdown\.math must be true or false/);
  assert.deepEqual(await outputHashes(output), goodOutput);

  const recoveredConfig = themedConfig.replace("#123456", "#654321");
  await writeFile(configSource, recoveredConfig, "utf8");
  const recovered = await engine.rebuild([configRelative]);
  assertMode(recovered, "full", 1);
  assert.match(
    await readFile(path.join(output, "_inkpath", "theme.css"), "utf8"),
    /--willow: #654321/,
  );
  await assertMatchesCleanBuild(project);
});
