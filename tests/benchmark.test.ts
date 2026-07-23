import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateBenchmarkSite } from "../benchmarks/generate.js";
import { buildSite } from "../src/build.js";

test("generates an exact, deterministic, representative benchmark site", async (t) => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-benchmark-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-benchmark-second-"));
  t.after(async () => {
    await Promise.all([
      rm(firstRoot, { force: true, recursive: true }),
      rm(secondRoot, { force: true, recursive: true }),
    ]);
  });

  const options = { linkFanout: 4, pages: 100, profile: "rich" as const };
  const first = await generateBenchmarkSite(firstRoot, options);
  const second = await generateBenchmarkSite(secondRoot, options);

  assert.equal(first.pages, 100);
  assert.equal(first.pages, first.notes + first.sections + 1);
  assert.equal(
    first.manifest.filter((entry) => entry.path.toLowerCase().endsWith(".md")).length,
    100,
  );
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.mutationTargetsSha256, second.mutationTargetsSha256);
  assert.equal(first.suiteSha256, second.suiteSha256);
  assert.deepEqual(first.scenarioOracles, second.scenarioOracles);
  assert.equal(
    await readFile(first.manifestPath, "utf8"),
    await readFile(second.manifestPath, "utf8"),
  );

  const stableFirst = { ...first, manifestPath: undefined, root: undefined };
  const stableSecond = { ...second, manifestPath: undefined, root: undefined };
  assert.deepEqual(stableFirst, stableSecond);
  assert.ok(
    first.manifest.some(
      (entry) =>
        entry.path.startsWith("content/") &&
        entry.path.split("/").length >= 4 &&
        entry.path.endsWith("/INDEX.md"),
    ),
    "the fixture should contain nested sections",
  );

  const generatedMarkdown = (
    await Promise.all(
      first.manifest
        .filter((entry) => entry.path.endsWith(".md"))
        .map((entry) => readFile(path.join(first.root, entry.path), "utf8")),
    )
  ).join("\n");
  assert.match(generatedMarkdown, /This ordinary prose models a knowledge-base page/);
  assert.match(generatedMarkdown, /### Nested detail/);
  assert.match(generatedMarkdown, /Dense links: (?:\[[^\]]+\]\([^)]+\), ){3}\[[^\]]+\]\([^)]+\)\./);
  assert.match(generatedMarkdown, /```ts/);
  assert.match(generatedMarkdown, /\[section data\]\(benchmark-asset\.txt\)/);
  assert.match(generatedMarkdown, /```mermaid/);
  assert.match(generatedMarkdown, /Inline benchmark math is rendered at build time/);

  for (const mutation of [
    first.mutationTargets.body,
    first.mutationTargets.title,
    first.mutationTargets.route,
    first.mutationTargets.link,
  ]) {
    const source = await readFile(path.join(first.root, mutation.path), "utf8");
    assert.ok(source.includes(mutation.before), `${mutation.path} should contain its old text`);
    assert.ok(!source.includes(mutation.after), `${mutation.path} should not contain its new text`);
  }
  await access(path.join(first.root, first.mutationTargets.deletion.path));
  await access(path.join(first.root, first.mutationTargets.rename.from));
  await assert.rejects(access(path.join(first.root, first.mutationTargets.rename.to)));
  await assert.rejects(access(path.join(first.root, first.mutationTargets.addition.path)));

  const build = await buildSite(first.root, { write: false });
  assert.equal(build.pages, 100);
  assert.ok(build.diagrams > 0);
  assert.ok(build.math > 0);

  for (const mutation of [
    first.mutationTargets.body,
    first.mutationTargets.title,
    first.mutationTargets.route,
    first.mutationTargets.link,
  ]) {
    const target = path.join(first.root, mutation.path);
    const original = await readFile(target, "utf8");
    const updated = original.replace(mutation.before, mutation.after);
    assert.notEqual(updated, original);
    await writeFile(target, updated, "utf8");
    assert.equal((await buildSite(first.root, { write: false })).pages, 100);
    await writeFile(target, original, "utf8");
  }

  const addition = first.mutationTargets.addition;
  await writeFile(path.join(first.root, addition.path), addition.content, {
    encoding: "utf8",
    flag: "wx",
  });
  assert.equal((await buildSite(first.root, { write: false })).pages, 101);
  await rm(path.join(first.root, addition.path));

  const deletion = first.mutationTargets.deletion;
  const deletedContent = await readFile(path.join(first.root, deletion.path), "utf8");
  await rm(path.join(first.root, deletion.path));
  assert.equal((await buildSite(first.root, { write: false })).pages, 99);
  await writeFile(path.join(first.root, deletion.path), deletedContent, "utf8");

  const renameTarget = first.mutationTargets.rename;
  await rename(path.join(first.root, renameTarget.from), path.join(first.root, renameTarget.to));
  assert.equal((await buildSite(first.root, { write: false })).pages, 100);
  await rename(path.join(first.root, renameTarget.to), path.join(first.root, renameTarget.from));
  await assert.rejects(access(path.join(first.root, "site")));
});

type CompiledBenchmarkRunner = {
  runWorker(request: Record<string, unknown>): Promise<{
    changedPaths: string[];
    engine: string;
    outputManifest?: { bytes: number; files: number; sha256: string };
    protocolVersion: number;
    timing: { adapterMs: number; engineCallMs: number; operationMs: number };
  }>;
};

async function compiledBenchmarkRunner(): Promise<CompiledBenchmarkRunner> {
  const compiled = path.resolve(".inkpath-benchmark", "runner", "run.js");
  await access(compiled);
  return (await import(pathToFileURL(compiled).href)) as CompiledBenchmarkRunner;
}

function mutationTargets() {
  return {
    addition: { content: "added\n", path: "content/added.md" },
    body: { after: "variant B", before: "variant A", path: "content/note.md" },
    deletion: { path: "content/deleted.md" },
    link: { after: "link B", before: "link A", path: "content/note.md" },
    rename: { from: "content/rename.md", to: "content/renamed.md" },
    route: { after: "route B", before: "route A", path: "content/note.md" },
    title: { after: "title B", before: "title A", path: "content/note.md" },
  };
}

test("plain-JavaScript runner rejects an incremental rebuild with stale output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-benchmark-protocol-"));
  const projectDirectory = path.join(root, "project");
  const contentDirectory = path.join(projectDirectory, "content");
  const outputDirectory = path.join(projectDirectory, "site");
  const sourcePath = path.join(contentDirectory, "note.md");
  const goodModule = path.join(root, "good-engine.mjs");
  const badModule = path.join(root, "bad-engine.mjs");
  const canonicalModule = path.join(root, "canonical-engine.mjs");
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(contentDirectory, { recursive: true });
  await writeFile(sourcePath, "variant A\n", "utf8");

  const modulePreamble = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function render(projectDirectory, options) {
  const outputDirectory = path.join(projectDirectory, "site");
  const body = await readFile(path.join(projectDirectory, "content", "note.md"), "utf8");
  if (options.write) {
    await mkdir(path.join(outputDirectory, "note"), { recursive: true });
    await writeFile(path.join(outputDirectory, "note", "index.html"), body, "utf8");
  }
  return { pages: 1, site: { config: { outputDir: outputDirectory } } };
}
`;
  await writeFile(
    goodModule,
    `${modulePreamble}
export async function createBuildEngine(projectDirectory) {
  return {
    build(options) { return render(projectDirectory, options); },
    rebuild(changedPaths, options = { profile: true, write: true }) {
      if (JSON.stringify(changedPaths) !== JSON.stringify(["content/note.md"])) {
        throw new Error("runner did not pass explicit changed paths");
      }
      return render(projectDirectory, options);
    },
  };
}
`,
    "utf8",
  );
  await writeFile(
    badModule,
    `${modulePreamble}
export async function createBuildEngine(projectDirectory) {
  let cached;
  return {
    async build(options) {
      cached = await render(projectDirectory, options);
      return cached;
    },
    async rebuild(_changedPaths, _options) { return cached; },
  };
}
`,
    "utf8",
  );
  await writeFile(
    canonicalModule,
    `${modulePreamble}
let calls = 0;
export async function buildSite(projectDirectory, options) {
  calls += 1;
  if (calls > 1) throw new Error("canonical validation built more than once");
  return render(projectDirectory, options);
}
`,
    "utf8",
  );

  const runner = await compiledBenchmarkRunner();
  const request = {
    buildModule: goodModule,
    engineMode: "auto",
    mutationTargets: mutationTargets(),
    oracle: {
      expectedPages: 1,
      outputFiles: [
        {
          contains: ["variant B"],
          excludes: ["variant A"],
          exists: true,
          path: "note/index.html",
        },
      ],
    },
    outputDirectory,
    projectDirectory,
    scenario: "body-edit",
  };
  const valid = await runner.runWorker(request);
  assert.equal(valid.protocolVersion, 2);
  assert.equal(valid.engine, "createBuildEngine");
  assert.deepEqual(valid.changedPaths, ["content/note.md"]);
  assert.equal(valid.outputManifest?.files, 1);

  await writeFile(sourcePath, "variant A\n", "utf8");
  await rm(outputDirectory, { force: true, recursive: true });
  await assert.rejects(
    runner.runWorker({ ...request, buildModule: badModule }),
    /benchmark semantic oracle/,
  );

  await writeFile(sourcePath, "variant A\n", "utf8");
  await rm(outputDirectory, { force: true, recursive: true });
  const canonical = await runner.runWorker({
    ...request,
    buildModule: canonicalModule,
    cleanAfterMutation: true,
    engineMode: "baseline",
  });
  assert.equal(canonical.engine, "buildSite");
  assert.deepEqual(canonical.changedPaths, ["content/note.md"]);
  assert.equal(canonical.outputManifest?.files, 1);
  assert.equal(
    await readFile(path.join(outputDirectory, "note", "index.html"), "utf8"),
    "variant B\n",
  );
});

test("cold benchmark timing includes factory setup after output cleanup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-benchmark-cold-protocol-"));
  const projectDirectory = path.join(root, "project");
  const outputDirectory = path.join(projectDirectory, "site");
  const buildModule = path.join(root, "cold-engine.mjs");
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "stale.txt"), "stale\n", "utf8");
  await writeFile(
    buildModule,
    `
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createBuildEngine(projectDirectory) {
  const outputDirectory = path.join(projectDirectory, "site");
  if (existsSync(outputDirectory)) throw new Error("output was not removed before factory setup");
  const started = performance.now();
  while (performance.now() - started < 35) {}
  const build = async (options) => {
    if (options.write) {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, "index.html"), "ready\\n", "utf8");
    }
    return { pages: 1, site: { config: { outputDir: outputDirectory } } };
  };
  return { build, rebuild: (_changedPaths, options) => build(options) };
}
`,
    "utf8",
  );

  const runner = await compiledBenchmarkRunner();
  const result = await runner.runWorker({
    buildModule,
    engineMode: "auto",
    mutationTargets: mutationTargets(),
    oracle: {
      expectedPages: 1,
      outputFiles: [{ contains: ["ready"], exists: true, path: "index.html" }],
    },
    outputDirectory,
    projectDirectory,
    scenario: "clean-build",
  });
  assert.ok(result.timing.adapterMs >= 30);
  assert.ok(result.timing.operationMs >= result.timing.adapterMs);
  assert.ok(result.timing.operationMs >= result.timing.engineCallMs);
});
