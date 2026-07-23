import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { buildSite } from "../src/build.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");
const compressedPageBudget = 15 * 1024;

type TransferSize = {
  brotli: number;
  gzip: number;
  raw: number;
  stylesheets: string[];
};

function localOutputPath(outputRoot: string, href: string): string {
  const pathname = new URL(href, "https://inkpath.test").pathname;
  assert.match(pathname, /^\/docs\//, `expected a local asset under /docs, received ${href}`);
  const target = path.resolve(outputRoot, decodeURIComponent(pathname.slice("/docs/".length)));
  assert.equal(path.relative(outputRoot, target).startsWith(".."), false);
  return target;
}

async function transferSize(outputRoot: string, htmlPath: string): Promise<TransferSize> {
  const html = await readFile(htmlPath);
  const source = html.toString("utf8");
  const stylesheets = [...source.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(
    (match) => match[1]!,
  );
  assert.ok(stylesheets.length > 0, "the page must reference at least one stylesheet");

  const resources = [html];
  for (const stylesheet of stylesheets) {
    resources.push(await readFile(localOutputPath(outputRoot, stylesheet)));
  }

  // A cache-cold page view transfers separate HTTP responses. Compress each
  // response independently before summing, matching the benchmark methodology.
  return {
    brotli: resources.reduce(
      (total, resource) =>
        total +
        brotliCompressSync(resource, {
          params: {
            [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          },
        }).byteLength,
      0,
    ),
    gzip: resources.reduce(
      (total, resource) => total + gzipSync(resource, { level: 9 }).byteLength,
      0,
    ),
    raw: resources.reduce((total, resource) => total + resource.byteLength, 0),
    stylesheets,
  };
}

function assertWithinBudget(label: string, size: TransferSize): void {
  assert.ok(
    size.gzip <= compressedPageBudget,
    `${label} HTML + CSS is ${size.gzip} gzip bytes; budget is ${compressedPageBudget}`,
  );
  assert.ok(
    size.brotli <= compressedPageBudget,
    `${label} HTML + CSS is ${size.brotli} Brotli bytes; budget is ${compressedPageBudget}`,
  );
}

test("keeps ordinary and enhanced pages within their transfer budgets", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "inkpath-output-budget-"));
  t.after(() => rm(project, { force: true, recursive: true }));
  await cp(fixtureRoot, project, { recursive: true });

  await buildSite(project);
  const output = path.join(project, "site");
  const featurePath = path.join(output, "foundations", "first", "index.html");
  const ordinaryPath = path.join(output, "foundations", "second", "index.html");
  const featureHtml = await readFile(featurePath, "utf8");
  const ordinaryHtml = await readFile(ordinaryPath, "utf8");

  const ordinarySize = await transferSize(output, ordinaryPath);
  assert.deepEqual(ordinarySize.stylesheets, ["/docs/_inkpath/theme.css"]);
  assertWithinBudget("ordinary page", ordinarySize);

  const featureSize = await transferSize(output, featurePath);
  assert.deepEqual(featureSize.stylesheets, [
    "/docs/_inkpath/theme.css",
    "/docs/_inkpath/katex/katex.min.css",
  ]);
  assertWithinBudget("Mermaid and KaTeX page", featureSize);

  for (const ordinaryPage of [
    path.join(output, "index.html"),
    path.join(output, "foundations", "index.html"),
    ordinaryPath,
  ]) {
    const html = await readFile(ordinaryPage, "utf8");
    assert.doesNotMatch(html, /<script(?:\s|>)/i);
    assert.doesNotMatch(html, /data-inkpath-diagram|katex\.min\.css|class="katex"/);
  }

  assert.match(
    featureHtml,
    /<pre class="mermaid" data-inkpath-diagram>[\s\S]*accTitle: A small request path[\s\S]*accDescr: A client sends a request to an application/,
  );
  assert.match(featureHtml, /<span class="katex-mathml"><math\b/);
  assert.match(featureHtml, /<span class="katex-html" aria-hidden="true">/);
  const mermaidScript = featureHtml.match(
    /<script type="module" src="(\/docs\/_inkpath\/inkpath-[A-Z0-9]+\.js)"><\/script>/,
  );
  assert.ok(mermaidScript?.[1]);
  await readFile(localOutputPath(output, mermaidScript[1]));
  assert.equal(featureHtml.match(/<script\b/g)?.length, 1);

  for (const html of [ordinaryHtml, featureHtml]) {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<a class="skip-link" href="#main-content">Skip to content<\/a>/);
    assert.match(html, /<main class="page-shell" id="main-content">/);
  }
  assert.match(featureHtml, /role="note" aria-labelledby="__inkpath-annotation-1-label"/);
});
