import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

async function outputHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const relative = path.relative(root, entryPath).split(path.sep).join("/");
        hashes.set(
          relative,
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

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("preserves the last good build, recovers, and removes stale routes", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-recovery-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await cp(fixtureRoot, project, { recursive: true });

  await buildSite(project);
  const output = path.join(project, "site");
  const firstOutput = path.join(output, "foundations", "first", "index.html");
  const hashesBeforeFailure = await outputHashes(output);
  const bytesBeforeFailure = await readFile(firstOutput);

  for (const ordinaryPage of [
    path.join(output, "index.html"),
    path.join(output, "foundations", "index.html"),
    path.join(output, "foundations", "second", "index.html"),
  ]) {
    assert.doesNotMatch(await readFile(ordinaryPage, "utf8"), /<script(?:\s|>)/i);
  }

  const firstSource = path.join(project, "content", "01-foundations", "01-first.md");
  const validSource = await readFile(firstSource, "utf8");
  const invalidSource = validSource.replace("#second-section", "#missing-section");
  assert.notEqual(invalidSource, validSource);
  await writeFile(firstSource, invalidSource, "utf8");

  await assert.rejects(buildSite(project), /missing anchor #missing-section/);
  assert.deepEqual(await outputHashes(output), hashesBeforeFailure);
  assert.deepEqual(await readFile(firstOutput), bytesBeforeFailure);

  const recoveredSource = validSource.replace(
    "This first sentence becomes the automatic summary.",
    "The repaired build is now published.",
  );
  await writeFile(firstSource, recoveredSource, "utf8");
  await buildSite(project);

  const recoveredBytes = await readFile(firstOutput);
  assert.notDeepEqual(recoveredBytes, bytesBeforeFailure);
  assert.match(recoveredBytes.toString("utf8"), /The repaired build is now published\./);
  assert.notDeepEqual(await outputHashes(output), hashesBeforeFailure);

  const contentDirectory = path.join(project, "content", "01-foundations");
  const staleSource = path.join(contentDirectory, "03-stale.md");
  const renamedSource = path.join(contentDirectory, "03-renamed.md");
  const staleOutput = path.join(output, "foundations", "stale", "index.html");
  const renamedOutput = path.join(output, "foundations", "renamed", "index.html");
  await writeFile(
    staleSource,
    "---\ntitle: Disposable note\n---\n\nThis route is safe to remove.\n",
    "utf8",
  );
  await buildSite(project);
  assert.equal(await exists(staleOutput), true);

  await rename(staleSource, renamedSource);
  await buildSite(project);
  assert.equal(await exists(staleOutput), false);
  assert.match(await readFile(renamedOutput, "utf8"), /Disposable note/);

  await rm(renamedSource);
  await buildSite(project);
  assert.equal(await exists(renamedOutput), false);
});
