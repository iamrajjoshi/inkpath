import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import YAML from "yaml";
import {
  COMPARISON_TOOLS,
  generateComparisonCorpus,
  projectComparisonCorpus,
  type ComparisonTool,
} from "../benchmarks/comparison/corpus.js";
import {
  assertCleanGitIdentity,
  loadComparisonVersionLock,
  normalizeDistributionName,
} from "../benchmarks/comparison/provenance.js";
import { overlayQuartzSources } from "../benchmarks/comparison/run.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("comparison provenance rejects a dirty pinned source checkout", () => {
  assert.doesNotThrow(() =>
    assertCleanGitIdentity(
      { branch: null, commit: "a".repeat(40), dirty: false, dirtyPaths: [] },
      "fixture",
    ),
  );
  assert.throws(
    () =>
      assertCleanGitIdentity(
        {
          branch: null,
          commit: "a".repeat(40),
          dirty: true,
          dirtyPaths: ["quartz/bootstrap-cli.mjs"],
        },
        "Quartz source checkout",
      ),
    /Quartz source checkout has modified or untracked paths: quartz\/bootstrap-cli\.mjs/,
  );
});

test("Quartz source overlay keeps worker cache imports sample-local", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-quartz-overlay-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const installRoot = path.join(root, "install");
  const sourceRoot = path.join(installRoot, "quartz");
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(sourceRoot, ".quartz-cache"), { recursive: true });
  await mkdir(path.join(sourceRoot, "processors"), { recursive: true });
  await mkdir(projectRoot);
  await writeFile(
    path.join(sourceRoot, "bootstrap-worker.mjs"),
    'await import("./.quartz-cache/transpiled-worker.mjs");\n',
  );
  await writeFile(path.join(sourceRoot, "processors", "parse.ts"), "export {};\n");
  await writeFile(path.join(sourceRoot, ".quartz-cache", "stale.mjs"), "export {};\n");

  await overlayQuartzSources(projectRoot, installRoot);

  const worker = path.join(projectRoot, "quartz", "bootstrap-worker.mjs");
  assert.equal((await lstat(worker)).isSymbolicLink(), false);
  assert.match(await readFile(worker, "utf8"), /transpiled-worker/);
  const processors = path.join(projectRoot, "quartz", "processors");
  assert.equal((await lstat(processors)).isSymbolicLink(), true);
  assert.equal(await readlink(processors), path.join(sourceRoot, "processors"));
  await assert.rejects(lstat(path.join(projectRoot, "quartz", ".quartz-cache")), {
    code: "ENOENT",
  });
});

test("comparison version lock freezes every benchmark installation", async (t) => {
  const loaded = await loadComparisonVersionLock(repositoryRoot);
  assert.equal(loaded.data.schemaVersion, 1);
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(loaded.data.tools.hugo.version, "0.164.0");
  assert.match(loaded.data.tools.hugo.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(loaded.data.tools.mkdocs.distributions.mkdocs, "1.6.1");
  assert.equal(loaded.data.tools.mkdocs.distributions.packaging, "26.2");
  assert.deepEqual(loaded.data.tools.docusaurus.packages, {
    "@docusaurus/core": "3.10.2",
    "@docusaurus/preset-classic": "3.10.2",
    react: "19.2.7",
    "react-dom": "19.2.7",
  });
  assert.match(loaded.data.tools.docusaurus.packageLockSha256, /^[a-f0-9]{64}$/);
  assert.match(loaded.data.tools.docusaurus.corePackageSha256, /^[a-f0-9]{64}$/);
  assert.equal(loaded.data.tools.quartz.commit.length, 40);
  assert.equal(Object.keys(loaded.data.tools.quartz.pluginCheckouts).length, 10);
  assert.equal(
    loaded.data.tools.quartz.pluginCheckouts["og-image"]?.commit,
    "ab1f8e5ddcd3d9e9c55ea9f8f4163ae34cabe6ce",
  );
  assert.match(loaded.data.tools.quartz.packageLockSha256, /^[a-f0-9]{64}$/);
  assert.match(loaded.data.tools.quartz.pluginLockSha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizeDistributionName("PyYAML_env.tag"), "pyyaml-env-tag");

  const malformedRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-lock-"));
  t.after(() => rm(malformedRoot, { force: true, recursive: true }));
  const malformedDirectory = path.join(malformedRoot, "benchmarks", "comparison");
  await mkdir(malformedDirectory, { recursive: true });
  const malformed = structuredClone(loaded.data) as unknown as {
    tools: { hugo: { executableSha256: string } };
  };
  malformed.tools.hugo.executableSha256 = "not-a-digest";
  await writeFile(
    path.join(malformedDirectory, "versions.lock.json"),
    `${JSON.stringify(malformed)}\n`,
    "utf8",
  );
  await assert.rejects(loadComparisonVersionLock(malformedRoot), /must be a SHA-256 digest/);
});
import {
  outputSummaryCacheStatsForTests,
  resetOutputSummaryCacheForTests,
  summarizeOutput,
  validateSemanticPages,
  type ByteCounts,
  type OutputCategory,
} from "../benchmarks/comparison/output.js";

test("output summary matches sequential gzip-9 and Brotli-11 accounting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-output-"));
  const identicalRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-output-copy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(identicalRoot, { force: true, recursive: true }));
  resetOutputSummaryCacheForTests();
  t.after(resetOutputSummaryCacheForTests);
  const fixture = new Map<string, string | Buffer>([
    ["assets/app.js", "const message = 'comparison';\n".repeat(17)],
    ["assets/data.bin", Buffer.from([0, 1, 2, 3, 255, 254, 253])],
    ["assets/module.mjs", "export const comparison = true;\n".repeat(11)],
    ["assets/site.css", ".comparison { color: rebeccapurple; }\n".repeat(19)],
    ["index.html", "<!doctype html><main>comparison home</main>\n"],
  ]);
  for (let index = 0; index < 12; index += 1) {
    fixture.set(
      `notes/note-${String(index).padStart(2, "0")}/index.html`,
      `<main>comparison note ${index} ${"body ".repeat(index * 7 + 1)}</main>\n`,
    );
  }
  for (const outputRoot of [root, identicalRoot]) {
    for (const [relativePath, contents] of fixture) {
      const absolutePath = path.join(outputRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }
  }

  const emptyCounts = (): ByteCounts => ({
    brotliBytes: 0,
    files: 0,
    gzipBytes: 0,
    rawBytes: 0,
  });
  const byCategory: Record<OutputCategory, ByteCounts> = {
    css: emptyCounts(),
    html: emptyCounts(),
    javascript: emptyCounts(),
    other: emptyCounts(),
  };
  const hash = createHash("sha256");
  const sortedFixture = [...fixture].sort(([left], [right]) => left.localeCompare(right, "en"));
  for (const [relativePath, source] of sortedFixture) {
    const contents = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const extension = path.extname(relativePath).toLowerCase();
    const category: OutputCategory =
      extension === ".html" || extension === ".htm"
        ? "html"
        : extension === ".css"
          ? "css"
          : extension === ".js" || extension === ".mjs" || extension === ".cjs"
            ? "javascript"
            : "other";
    const counts = byCategory[category];
    counts.files += 1;
    counts.rawBytes += contents.byteLength;
    counts.gzipBytes += gzipSync(contents, { level: 9 }).byteLength;
    counts.brotliBytes += brotliCompressSync(contents, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]:
          category === "other" ? zlibConstants.BROTLI_MODE_GENERIC : zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength;
    const name = Buffer.from(relativePath);
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32BE(name.byteLength);
    const contentsLength = Buffer.allocUnsafe(8);
    contentsLength.writeBigUInt64BE(BigInt(contents.byteLength));
    hash.update(nameLength).update(name).update(contentsLength).update(contents);
  }
  const expected = {
    byCategory,
    files: fixture.size,
    sha256: hash.digest("hex"),
  };

  assert.deepEqual(await summarizeOutput(root), expected);
  assert.deepEqual(outputSummaryCacheStatsForTests(), { entries: 1, hits: 0, misses: 1 });
  assert.deepEqual(await summarizeOutput(identicalRoot), expected);
  assert.deepEqual(outputSummaryCacheStatsForTests(), { entries: 1, hits: 1, misses: 1 });

  const changedHome = "<!doctype html><main>comparison HOME</main>\n";
  assert.equal(Buffer.byteLength(changedHome), Buffer.byteLength(fixture.get("index.html")!));
  await writeFile(path.join(identicalRoot, "index.html"), changedHome);
  const changed = await summarizeOutput(identicalRoot);
  assert.notEqual(changed.sha256, expected.sha256);
  assert.equal(changed.files, expected.files);
  for (const category of ["css", "html", "javascript", "other"] as const) {
    assert.equal(changed.byCategory[category].files, expected.byCategory[category].files);
    assert.equal(changed.byCategory[category].rawBytes, expected.byCategory[category].rawBytes);
  }
  assert.deepEqual(outputSummaryCacheStatsForTests(), { entries: 2, hits: 1, misses: 2 });
});

test("comparison corpus is exact, deterministic, nested, and representative", () => {
  assert.throws(() => generateComparisonCorpus({ pages: 19 }), /at least 20/);
  assert.throws(() => generateComparisonCorpus({ pages: 20.5 }), /integer/);

  const first = generateComparisonCorpus({ pages: 20 });
  const second = generateComparisonCorpus({ pages: 20 });
  assert.deepEqual(first, second);
  assert.equal(first.pages, 20);
  assert.equal(first.notes.length, 20);
  assert.equal(new Set(first.notes.map((note) => note.id)).size, 20);
  assert.equal(new Set(first.notes.map((note) => note.marker)).size, 20);
  assert.ok(first.notes.some((note) => note.kind === "section" && note.routeSegments.length === 2));
  assert.ok(first.notes.some((note) => note.kind === "note" && note.routeSegments.length === 3));

  for (const note of first.notes) {
    assert.equal(note.linkTargetIds.length, 4);
    assert.equal(new Set(note.linkTargetIds).size, 4);
    assert.ok(!note.linkTargetIds.includes(note.id));
    for (const target of note.linkTargetIds) {
      assert.ok(first.notes.some((candidate) => candidate.id === target));
    }
  }

  const leafNotes = first.notes.filter((note) => note.kind === "note");
  assert.equal(leafNotes.length, 15);
  assert.deepEqual(
    leafNotes.filter((note) => note.typescript).map((note) => note.noteOrdinal),
    [10],
  );
  assert.deepEqual(
    leafNotes.filter((note) => note.asset).map((note) => note.noteOrdinal),
    [13],
  );
});

const expectedConventionPaths: Record<ComparisonTool, readonly string[]> = {
  docusaurus: [
    "docusaurus.config.mjs",
    "docs/index.md",
    "docs/guides/index.md",
    "docs/guides/foundations/note-000001.md",
  ],
  hugo: [
    "hugo.toml",
    "content/_index.md",
    "content/guides/_index.md",
    "content/guides/foundations/note-000001.md",
  ],
  inkpath: [
    "inkpath.yaml",
    "content/INDEX.md",
    "content/guides/INDEX.md",
    "content/guides/foundations/note-000001.md",
  ],
  mkdocs: [
    "mkdocs.yml",
    "docs/index.md",
    "docs/guides/index.md",
    "docs/guides/foundations/note-000001.md",
  ],
  quartz: [
    "quartz.config.yaml",
    "content/index.md",
    "content/guides/index.md",
    "content/guides/foundations/note-000001.md",
  ],
};

test("projects equivalent native layouts for every comparison tool", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-projects-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const corpus = generateComparisonCorpus({ pages: 20 });

  for (const tool of COMPARISON_TOOLS) {
    const root = path.join(temporaryRoot, tool);
    const project = await projectComparisonCorpus(corpus, tool, root);
    assert.equal(project.tool, tool);
    assert.equal(project.pages, 20);
    assert.equal(project.root, path.resolve(root));
    assert.equal(project.expectedMarkers.length, 20);
    assert.equal(new Set(project.expectedMarkers).size, 20);
    assert.equal(project.expectedPages.length, 20);
    assert.equal(new Set(project.expectedPages.map((page) => page.outputPath)).size, 20);
    assert.ok(project.expectedPages.every((page) => page.linkTargetRoutes.length === 4));
    assert.ok(path.isAbsolute(project.configPath));
    assert.ok(path.isAbsolute(project.contentDirectory));
    assert.ok(path.isAbsolute(project.outputDirectory));
    await access(project.configPath);

    if (tool === "docusaurus") {
      const config = await readFile(project.configPath, "utf8");
      assert.match(config, /cacheDirectory: path\.join\(projectRoot, "\.cache", "webpack"\)/);
    }

    if (tool === "mkdocs") {
      const config = YAML.parse(await readFile(project.configPath, "utf8")) as {
        plugins: unknown[];
      };
      assert.deepEqual(config.plugins, []);
    }

    if (tool === "quartz") {
      const config = YAML.parse(await readFile(project.configPath, "utf8")) as {
        configuration: {
          analytics: unknown;
          enableSPA: boolean;
          theme: { fontOrigin: string };
        };
        layout: { byPageType: Record<string, unknown> };
        plugins: Array<{ enabled: boolean; source: string }>;
      };
      assert.equal(config.configuration.analytics, null);
      assert.equal(config.configuration.enableSPA, false);
      assert.equal(config.configuration.theme.fontOrigin, "local");
      assert.deepEqual(Object.keys(config.layout.byPageType), ["404", "content", "folder"]);
      assert.deepEqual(
        config.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.source),
        [
          "github:quartz-community/note-properties",
          "github:quartz-community/syntax-highlighting",
          "github:quartz-community/github-flavored-markdown",
          "github:quartz-community/crawl-links",
          "github:quartz-community/description",
          "github:quartz-community/remove-draft",
          "github:quartz-community/content-page",
          "github:quartz-community/folder-page",
          "github:quartz-community/footer",
        ],
      );
    }

    const manifestPaths = new Set(project.manifest.map((entry) => entry.path));
    assert.equal(
      project.manifest.filter((entry) => entry.path.includes("benchmark-asset-")).length,
      1,
    );
    for (const expectedPath of expectedConventionPaths[tool]) {
      assert.ok(manifestPaths.has(expectedPath), `${tool} should contain ${expectedPath}`);
    }

    const markdownPaths = project.manifest
      .map((entry) => entry.path)
      .filter((entryPath) => entryPath.endsWith(".md"));
    assert.equal(markdownPaths.length, 20);
    const markdownSources = await Promise.all(
      markdownPaths.map((entryPath) => readFile(path.join(root, entryPath), "utf8")),
    );
    assert.equal(markdownSources.filter((source) => source.includes("```ts")).length, 1);
    assert.equal(
      markdownSources.filter((source) => source.includes("[deterministic text]")).length,
      1,
    );

    for (const source of markdownSources) {
      assert.match(source, /This ordinary prose represents a practical documentation note/);
      assert.match(source, /\n## Overview\n/);
      assert.match(source, /\n## Details\n/);
      const linkTargets = [...source.matchAll(/\]\(([^)]+#details)\)/g)].map((match) => match[1]);
      assert.equal(linkTargets.length, 4);
      assert.ok(linkTargets.every((target) => target && !target.startsWith("/")));
      assert.ok(linkTargets.every((target) => target?.endsWith(".md#details")));
    }

    const assetSourcePath = markdownPaths.find((entryPath, index) =>
      markdownSources[index]?.includes("[deterministic text]"),
    );
    assert.ok(assetSourcePath);
    const assetSource = await readFile(path.join(root, assetSourcePath), "utf8");
    const assetTarget = assetSource.match(/\[deterministic text\]\(([^)]+)\)/)?.[1];
    assert.ok(assetTarget);
    await access(path.join(root, path.dirname(assetSourcePath), assetTarget));

    const mutationPath = path.join(root, project.mutation.path);
    assert.equal(await readFile(mutationPath, "utf8"), project.mutation.before);
    assert.match(project.mutation.before, new RegExp(project.mutation.forbiddenMarker));
    assert.doesNotMatch(project.mutation.before, new RegExp(project.mutation.expectedMarker));
    assert.match(project.mutation.after, new RegExp(project.mutation.expectedMarker));
    assert.doesNotMatch(project.mutation.after, new RegExp(project.mutation.forbiddenMarker));
    await writeFile(mutationPath, project.mutation.after, "utf8");
    assert.equal(await readFile(mutationPath, "utf8"), project.mutation.after);

    await rm(root, { force: true, recursive: true });
  }
});

test("comparison projection is deterministic and refuses a non-empty root", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-identity-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const corpus = generateComparisonCorpus({ pages: 20 });
  const firstRoot = path.join(temporaryRoot, "first");
  const secondRoot = path.join(temporaryRoot, "second");
  const first = await projectComparisonCorpus(corpus, "inkpath", firstRoot);
  const second = await projectComparisonCorpus(corpus, "inkpath", secondRoot);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(first.mutation, second.mutation);

  const occupied = path.join(temporaryRoot, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep.txt"), "user data\n", "utf8");
  await assert.rejects(projectComparisonCorpus(corpus, "hugo", occupied), /must be empty/);
  assert.equal(await readFile(path.join(occupied, "keep.txt"), "utf8"), "user data\n");
});

test("semantic validation requires route-local bodies, anchors, links, code, and assets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-comparison-semantics-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const outputPath = "guides/note/index.html";
  const pageDirectory = path.join(root, "guides", "note");
  await mkdir(pageDirectory, { recursive: true });
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "benchmark-asset-000013.txt"), "asset\n");
  const validHtml = `<!doctype html><html><head><meta name="description" content="pageMarker"></head><body>
<main><p>pageMarker</p><p>comparisonBodyVariantA</p><h2 id="details">Details</h2>
<a href="/one/#details">one</a><a href="/two/#details">two</a>
<a href="/three/#details">three</a><a href="/four/#details">four</a>
<a href="/assets/benchmark-asset-000013.txt">deterministic text</a>
<pre><code>const comparisonValue = 1;</code></pre></main></body></html>`;
  await writeFile(path.join(root, outputPath), validHtml);
  const pages = [
    {
      assetFileName: "benchmark-asset-000013.txt",
      assetSha256: createHash("sha256").update("asset\n").digest("hex"),
      linkTargetRoutes: ["/one/", "/two/", "/three/", "/four/"],
      marker: "pageMarker",
      outputPath,
      route: "/guides/note/",
      sourcePath: "content/guides/note.md",
      typescript: true,
    },
  ];
  assert.deepEqual(
    await validateSemanticPages(root, pages, {
      expectedMarker: "comparisonBodyVariantA",
      forbiddenMarker: "comparisonBodyVariantB",
      sourcePath: "content/guides/note.md",
    }),
    { anchors: 1, assets: 1, codeBlocks: 1, links: 4, pages: 1 },
  );

  await writeFile(
    path.join(root, outputPath),
    validHtml.replace(
      '<a href="/assets/benchmark-asset-000013.txt">',
      '<a href="https://other.example/benchmark-asset-000013.txt">decoy</a><a href="/assets/benchmark-asset-000013.txt">',
    ),
  );
  assert.deepEqual(
    await validateSemanticPages(root, pages, {
      expectedMarker: "comparisonBodyVariantA",
      forbiddenMarker: "comparisonBodyVariantB",
      sourcePath: "content/guides/note.md",
    }),
    { anchors: 1, assets: 1, codeBlocks: 1, links: 4, pages: 1 },
  );

  await writeFile(path.join(root, "assets", "benchmark-asset-000013.txt.bak"), "decoy\n");
  await writeFile(
    path.join(root, outputPath),
    validHtml.replace(
      "/assets/benchmark-asset-000013.txt",
      "/assets/benchmark-asset-000013.txt.bak",
    ),
  );
  await assert.rejects(
    validateSemanticPages(root, pages, {
      expectedMarker: "comparisonBodyVariantA",
      forbiddenMarker: "comparisonBodyVariantB",
      sourcePath: "content/guides/note.md",
    }),
    /generated page is missing its expected local asset/,
  );

  await writeFile(
    path.join(root, outputPath),
    validHtml.replace("/assets/benchmark-asset-000013.txt", "/missing/benchmark-asset-000013.txt"),
  );
  await assert.rejects(
    validateSemanticPages(root, pages, {
      expectedMarker: "comparisonBodyVariantA",
      forbiddenMarker: "comparisonBodyVariantB",
      sourcePath: "content/guides/note.md",
    }),
    /generated output is missing linked local asset at missing\/benchmark-asset-000013\.txt/,
  );

  await writeFile(
    path.join(root, outputPath),
    '<!doctype html><html><head><meta content="pageMarker"></head><body><h2 id="details">Details</h2></body></html>',
  );
  await assert.rejects(
    validateSemanticPages(root, pages, {
      expectedMarker: "comparisonBodyVariantA",
      forbiddenMarker: "comparisonBodyVariantB",
      sourcePath: "content/guides/note.md",
    }),
    /body marker exactly once/,
  );
});
