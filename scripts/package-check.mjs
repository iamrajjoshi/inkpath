import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const providedArchive = process.argv[2] ? path.resolve(repositoryRoot, process.argv[2]) : undefined;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-package-"));

try {
  const packages = path.join(temporaryRoot, "packages");
  const project = path.join(temporaryRoot, "project");
  await mkdir(packages);
  await mkdir(path.join(project, "content"), { recursive: true });
  await writeFile(path.join(project, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(
    path.join(project, "content", "INDEX.md"),
    "---\ntitle: Package check\ndescription: A site built from the packed npm artifact.\n---\n\n# Included heading\n\nInline math: $x + y$.\n\n```mermaid\nflowchart LR\n  accTitle: Package check\n  accDescr: The source becomes a generated page.\n  source[Source] --> page[Page]\n```\n",
  );
  await writeFile(path.join(project, "inkpath.yaml"), "markdown:\n  math: true\n");

  let archive = providedArchive;
  if (archive) {
    await access(archive);
    assert.match(archive, /\.tgz$/, "provided package should be an npm archive");
  } else {
    await execute("npm", ["pack", "--pack-destination", packages], {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_loglevel: "error" },
    });
    const archives = (await readdir(packages)).filter((name) => name.endsWith(".tgz"));
    assert.equal(archives.length, 1, "npm pack should produce one archive");
    archive = path.join(packages, archives[0]);
  }

  await execute("npm", ["install", "--no-audit", "--no-fund", archive], {
    cwd: project,
    env: { ...process.env, npm_config_loglevel: "error" },
  });

  const binary = path.join(
    project,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "inkpath.cmd" : "inkpath",
  );
  const version = await execute(binary, ["--version"], { cwd: project });
  assert.equal(version.stdout.trim(), packageMetadata.version);

  await execute(binary, ["build"], { cwd: project });
  await access(path.join(project, "site", "index.html"));
  await access(path.join(project, "site", "_inkpath", "katex", "katex.min.css"));
  const browserFiles = await readdir(path.join(project, "site", "_inkpath"));
  assert.ok(browserFiles.some((file) => /^inkpath-[A-Z0-9]+\.js$/.test(file)));
  assert.ok((await readdir(path.join(project, "site", "_inkpath", "chunks"))).length > 10);
  const installedPackage = path.join(project, "node_modules", ...packageMetadata.name.split("/"));
  await assert.rejects(access(path.join(installedPackage, "THIRD_PARTY_NOTICES.txt")));
  const installedRequire = createRequire(path.join(installedPackage, "package.json"));
  const katexRoot = path.dirname(installedRequire.resolve("katex/package.json"));
  const mermaidRoot = path.dirname(installedRequire.resolve("mermaid/package.json"));
  const katexMetadata = JSON.parse(await readFile(path.join(katexRoot, "package.json"), "utf8"));
  const mermaidMetadata = JSON.parse(
    await readFile(path.join(mermaidRoot, "package.json"), "utf8"),
  );
  const siteNotices = await readFile(
    path.join(project, "site", "_inkpath", "THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  assert.match(
    siteNotices,
    new RegExp(`mermaid@${mermaidMetadata.version.replaceAll(".", "\\.")}`),
  );
  assert.ok(
    siteNotices.includes((await readFile(path.join(mermaidRoot, "LICENSE"), "utf8")).trim()),
  );
  assert.equal(katexMetadata.version, "0.18.0");
  assert.equal(
    await readFile(path.join(project, "site", "_inkpath", "katex", "LICENSE.txt"), "utf8"),
    await readFile(path.join(katexRoot, "LICENSE"), "utf8"),
  );

  const imported = await execute(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const library = await import(${JSON.stringify(packageMetadata.name)}); console.log(JSON.stringify({ buildSite: typeof library.buildSite, version: library.INKPATH_VERSION }));`,
    ],
    { cwd: project },
  );
  const library = JSON.parse(imported.stdout);
  assert.equal(library.buildSite, "function");
  assert.equal(library.version, packageMetadata.version);

  console.log(`Checked ${packageMetadata.name}@${packageMetadata.version} from its npm archive`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
