import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createMarkdownRenderer,
  renderMarkdown,
  type MarkdownRenderResult,
} from "../src/markdown.js";
import type { InkpathConfig, Page, Site } from "../src/types.js";

function createPage(relativePath: string, body: string, route: string): Page {
  const sourceDirectory = path.posix.dirname(relativePath);
  return {
    attributes: {},
    backlinks: [],
    body,
    children: [],
    depth: 0,
    headings: [],
    kind: "page",
    order: 0,
    readingMinutes: 1,
    relativePath,
    rendered: "",
    route,
    slug: path.posix.basename(relativePath, ".md"),
    sourceDirectory: sourceDirectory === "." ? "" : sourceDirectory,
    sourcePath: path.join("/project/content", relativePath),
    summary: "Summary",
    title: path.posix.basename(relativePath, ".md"),
  };
}

function createSite(pages: Page[], math: boolean): Site {
  const config: InkpathConfig = {
    projectRoot: "/project",
    contentDir: "/project/content",
    outputDir: "/project/site",
    publicDir: "/project/public",
    markdown: { math },
    site: { basePath: "/docs", lang: "en" },
    theme: {
      accent: "#111111",
      interactive: "#222222",
      interactiveHover: "#333333",
      showListDetails: true,
      showPageDetails: true,
      subtle: "#444444",
    },
  };
  const home = pages[0];
  assert.ok(home);
  return {
    config,
    home,
    pages,
    pageByRoute: new Map(pages.map((page) => [page.route, page])),
    pageBySource: new Map(pages.map((page) => [page.relativePath, page])),
    sections: [],
  };
}

function snapshot(result: MarkdownRenderResult, page: Page) {
  return {
    anchors: [...result.anchors].sort(),
    assets: [...result.assets].sort(),
    diagrams: result.diagrams,
    headings: page.headings.map((heading) => ({ ...heading })),
    html: result.html,
    internalReferences: result.internalReferences.map((reference) => ({
      fragment: reference.fragment,
      target: reference.target.relativePath,
    })),
    math: result.math,
  };
}

const featureBody = `## Repeated

## Repeated

[First occurrence](#repeated)

> [!NOTE] First note
> Annotation body.

[Target](target.md#target-heading)

![Local asset](media/example%20image.png)

Inline math $x^2$.

$$
y = x + 1
$$

Footnote reference.[^one]

[^one]: Footnote body.

\`\`\`mermaid
flowchart TD
  accTitle: Accessible flow
  accDescr: A simple flow between two nodes
  A --> B
\`\`\`
`;

test("a reused renderer keeps all mutable state isolated by page", () => {
  const source = createPage("source.md", featureBody, "/source/");
  const target = createPage(
    "target.md",
    `## Target heading

> [!TIP] Target note
> Target body.
`,
    "/target/",
  );
  const site = createSite([source, target], true);
  const render = createMarkdownRenderer();

  const firstSource = snapshot(render(source, site), source);
  const targetResult = snapshot(render(target, site), target);
  const secondSource = snapshot(render(source, site), source);

  assert.deepEqual(secondSource, firstSource);
  assert.deepEqual(firstSource.anchors, ["__inkpath-footnotes-label", "repeated", "repeated-2"]);
  assert.deepEqual(firstSource.assets, ["media/example image.png"]);
  assert.deepEqual(firstSource.internalReferences, [
    { fragment: "repeated", target: "source.md" },
    { fragment: "target-heading", target: "target.md" },
  ]);
  assert.equal(firstSource.diagrams, 1);
  assert.equal(firstSource.math, 2);
  assert.deepEqual(firstSource.headings, [
    { depth: 2, id: "repeated", title: "Repeated" },
    { depth: 2, id: "repeated-2", title: "Repeated" },
  ]);
  assert.match(firstSource.html, /__inkpath-annotation-1-label/);

  assert.deepEqual(targetResult.anchors, ["target-heading"]);
  assert.deepEqual(targetResult.assets, []);
  assert.deepEqual(targetResult.internalReferences, []);
  assert.equal(targetResult.diagrams, 0);
  assert.equal(targetResult.math, 0);
  assert.deepEqual(targetResult.headings, [
    { depth: 2, id: "target-heading", title: "Target heading" },
  ]);
  assert.match(targetResult.html, /__inkpath-annotation-1-label/);
  assert.doesNotMatch(targetResult.html, /__inkpath-annotation-2-label/);
});

test("one renderer honors each site's math setting without leaking parser configuration", () => {
  const render = createMarkdownRenderer();
  const enabledPage = createPage("enabled.md", "Inline $x$.", "/enabled/");
  const disabledPage = createPage("disabled.md", "Inline $x$.", "/disabled/");
  const enabled = snapshot(render(enabledPage, createSite([enabledPage], true)), enabledPage);
  const disabled = snapshot(render(disabledPage, createSite([disabledPage], false)), disabledPage);

  assert.equal(enabled.math, 1);
  assert.match(enabled.html, /class="katex"/);
  assert.equal(disabled.math, 0);
  assert.match(disabled.html, /Inline \$x\$\./);
  assert.doesNotMatch(disabled.html, /class="katex"/);
});

test("the compatibility render API is equivalent to a build-scoped renderer", () => {
  const factorySource = createPage("source.md", featureBody, "/source/");
  const factoryTarget = createPage("target.md", "## Target heading", "/target/");
  const sharedSource = createPage("source.md", featureBody, "/source/");
  const sharedTarget = createPage("target.md", "## Target heading", "/target/");

  const fromFactory = snapshot(
    createMarkdownRenderer()(factorySource, createSite([factorySource, factoryTarget], true)),
    factorySource,
  );
  const fromCompatibilityApi = snapshot(
    renderMarkdown(sharedSource, createSite([sharedSource, sharedTarget], true)),
    sharedSource,
  );

  assert.deepEqual(fromCompatibilityApi, fromFactory);
});

test("a failed render does not poison the next page's environment", () => {
  const render = createMarkdownRenderer();
  const invalid = createPage(
    "broken.md",
    `\`\`\`mermaid
flowchart TD
  A --> B
\`\`\``,
    "/broken/",
  );
  const good = createPage("good.md", "## Good\n\n> [!NOTE] Safe\n> Still works.", "/good/");
  const site = createSite([invalid, good], true);

  assert.throws(() => render(invalid, site), /broken\.md: Mermaid diagrams need accTitle/);
  const result = snapshot(render(good, site), good);
  assert.deepEqual(result.anchors, ["good"]);
  assert.match(result.html, /__inkpath-annotation-1-label/);
  assert.equal(result.diagrams, 0);
  assert.equal(result.math, 0);
});
