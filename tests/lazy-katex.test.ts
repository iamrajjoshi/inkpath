import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("does not load KaTeX for a math-disabled build", async () => {
  const buildModule = pathToFileURL(path.join(repositoryRoot, "dist", "build.js")).href;
  const project = path.join(repositoryRoot, "examples", "basic");
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const katex = require.resolve("katex");
    const before = Boolean(require.cache[katex]);
    const { buildSite } = await import(${JSON.stringify(buildModule)});
    await buildSite(${JSON.stringify(project)}, { write: false });
    const after = Boolean(require.cache[katex]);
    console.log(JSON.stringify({ before, after }));
  `;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repositoryRoot,
  });

  assert.deepEqual(JSON.parse(result.stdout), { before: false, after: false });
});
