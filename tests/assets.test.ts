import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMermaidAssetManifest } from "../src/assets.js";

const noticeName = "THIRD_PARTY_NOTICES.txt";

type CacheFixture = {
  directory: string;
  entry: string;
  files: string[];
  manifest: {
    entry: string;
    files: string[];
    identity: string;
    notice: string;
  };
};

async function cacheFixture(root: string, name: string): Promise<CacheFixture> {
  const parent = path.join(root, name);
  const staged = path.join(parent, "staged");
  const entry = "inkpath-ABC123.js";
  const files = ["chunks/chunk-XYZ789.js", entry];
  await mkdir(path.join(staged, "chunks"), { recursive: true });
  await writeFile(path.join(staged, files[0] as string), "export const chunk = true;\n", "utf8");
  await writeFile(path.join(staged, entry), 'import "./chunks/chunk-XYZ789.js";\n', "utf8");
  await writeFile(path.join(staged, noticeName), "Synthetic third-party notices.\n", "utf8");

  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(path.join(staged, file)));
  }
  hash
    .update(noticeName)
    .update("\0")
    .update(await readFile(path.join(staged, noticeName)));
  const identity = hash.digest("hex");
  const directory = path.join(parent, `mermaid-${identity}`);
  await rename(staged, directory);
  const manifest = { entry, files, identity, notice: noticeName };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  return { directory, entry, files, manifest };
}

test("reuses only exact regular-file Mermaid cache trees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkpath-assets-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  await t.test("accepts the canonical cache tree", async () => {
    const fixture = await cacheFixture(root, "valid");
    assert.deepEqual(await readMermaidAssetManifest(fixture.directory), {
      directory: fixture.directory,
      entry: fixture.entry,
    });
  });

  await t.test("rejects an entry that is not a hashed output", async () => {
    const fixture = await cacheFixture(root, "unlisted-entry");
    await writeFile(
      path.join(fixture.directory, "manifest.json"),
      `${JSON.stringify({ ...fixture.manifest, entry: "inkpath-FAKE.js" })}\n`,
      "utf8",
    );
    assert.equal(await readMermaidAssetManifest(fixture.directory), undefined);
  });

  await t.test("rejects duplicate and reserved manifest files", async () => {
    const duplicate = await cacheFixture(root, "duplicate");
    await writeFile(
      path.join(duplicate.directory, "manifest.json"),
      `${JSON.stringify({
        ...duplicate.manifest,
        files: [...duplicate.files, duplicate.entry],
      })}\n`,
      "utf8",
    );
    assert.equal(await readMermaidAssetManifest(duplicate.directory), undefined);

    const reserved = await cacheFixture(root, "reserved");
    await writeFile(
      path.join(reserved.directory, "manifest.json"),
      `${JSON.stringify({
        ...reserved.manifest,
        files: [...reserved.files, "nested/manifest.json"].sort(),
      })}\n`,
      "utf8",
    );
    assert.equal(await readMermaidAssetManifest(reserved.directory), undefined);
  });

  await t.test("rejects unlisted files and directories", async () => {
    const extraFile = await cacheFixture(root, "extra-file");
    await writeFile(path.join(extraFile.directory, "extra.js"), "unexpected\n", "utf8");
    assert.equal(await readMermaidAssetManifest(extraFile.directory), undefined);

    const extraDirectory = await cacheFixture(root, "extra-directory");
    await mkdir(path.join(extraDirectory.directory, "unused"));
    assert.equal(await readMermaidAssetManifest(extraDirectory.directory), undefined);
  });

  await t.test("rejects a listed file replaced by a symbolic link", async (symlinkTest) => {
    const fixture = await cacheFixture(root, "symlink");
    const entryPath = path.join(fixture.directory, fixture.entry);
    const external = path.join(root, "external-entry.js");
    await writeFile(external, await readFile(entryPath));
    await rm(entryPath);
    try {
      await symlink(external, entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        symlinkTest.skip("symbolic links are unavailable on this platform");
        return;
      }
      throw error;
    }
    assert.equal(await readMermaidAssetManifest(fixture.directory), undefined);
  });
});
