import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the compiled CLI runs when invoked through a package-manager bin symlink", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-cli-"));
  const project = path.join(temporaryRoot, "project");
  const bin = path.join(temporaryRoot, "inkpath");
  await cp(path.join(repositoryRoot, "tests", "fixtures", "site"), project, { recursive: true });
  await symlink(path.join(repositoryRoot, "dist", "cli.js"), bin);

  const packageMetadata = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const version = await execute(process.execPath, [bin, "--version"]);
  assert.equal(version.stdout.trim(), packageMetadata.version);

  const checked = await execute(process.execPath, [bin, "check", project]);
  assert.match(checked.stdout, /Checked 4 pages \(1 diagram, 2 math expressions, 1 orphan note\)/);

  const built = await execute(process.execPath, [bin, "build", project]);
  assert.match(built.stdout, /Built 4 pages/);
  await access(path.join(project, "site", "index.html"));
});
