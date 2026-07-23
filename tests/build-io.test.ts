import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

test("preplanned output directories merge route and asset trees", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-build-io-"));
  t.after(() => rm(project, { force: true, recursive: true }));
  await cp(fixtureRoot, project, { recursive: true });

  await mkdir(path.join(project, "public", "foundations", "empty", "nested"), {
    recursive: true,
  });
  await writeFile(
    path.join(project, "public", "foundations", "static.txt"),
    "public asset\n",
    "utf8",
  );
  await mkdir(path.join(project, "content", "01-foundations", "asset-only", "empty", "nested"), {
    recursive: true,
  });

  await buildSite(project);

  const output = path.join(project, "site");
  assert.equal(
    await readFile(path.join(output, "foundations", "static.txt"), "utf8"),
    "public asset\n",
  );
  assert.match(
    await readFile(path.join(output, "foundations", "first", "index.html"), "utf8"),
    /<h1>First note<\/h1>/,
  );
  assert.deepEqual(await readdir(path.join(output, "foundations", "empty", "nested")), []);
  assert.deepEqual(
    await readdir(path.join(output, "_content", "01-foundations", "asset-only", "empty", "nested")),
    [],
  );
});
