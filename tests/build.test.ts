import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";
import { loadConfig } from "../src/config.js";
import { navigationPages } from "../src/content.js";
import { INKPATH_VERSION } from "../src/version.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");
const require = createRequire(import.meta.url);

async function packageDetails(name: string): Promise<{ license: string; version: string }> {
  const packageRoot = path.dirname(require.resolve(`${name}/package.json`));
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return {
    license: await readFile(path.join(packageRoot, "LICENSE"), "utf8"),
    version: metadata.version,
  };
}

async function copyFixture(): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-test-"));
  await cp(fixtureRoot, temporaryRoot, { recursive: true });
  return temporaryRoot;
}

async function outputHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) {
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

test("builds deterministic static pages with the complete Markdown surface", async () => {
  const project = await copyFixture();
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const firstBuild = await buildSite(project, { commitSha });
  assert.equal(firstBuild.pages, 4);
  assert.equal(firstBuild.diagrams, 1);
  assert.equal(firstBuild.math, 2);
  assert.equal(firstBuild.orphans, 1);

  const output = path.join(project, "site");
  const firstPage = await readFile(path.join(output, "foundations", "first", "index.html"), "utf8");
  const secondPage = await readFile(
    path.join(output, "foundations", "second", "index.html"),
    "utf8",
  );
  const sectionPage = await readFile(path.join(output, "foundations", "index.html"), "utf8");
  const homePage = await readFile(path.join(output, "index.html"), "utf8");

  assert.match(homePage, /Fixture notes/);
  assert.match(
    homePage,
    new RegExp(
      `<meta name="generator" content="Inkpath ${INKPATH_VERSION.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.match(homePage, /Small examples of the supported Markdown surface/);
  assert.match(homePage, /<body class="has-build-commit">/);
  assert.match(
    homePage,
    /<footer class="build-commit"><a href="https:\/\/github\.com\/iamrajjoshi\/inkpath\/commit\/0123456789abcdef0123456789abcdef01234567"><code>0123456<\/code><\/a><\/footer>/,
  );
  assert.doesNotMatch(
    [sectionPage, firstPage, secondPage].join("\n"),
    /has-build-commit|class="build-commit"/,
  );
  assert.match(
    homePage,
    /<img class="site-logo" src="\/docs\/favicon\.svg" alt="" width="28" height="28">/,
  );
  assert.doesNotMatch(homePage, /class="site-mark"/);
  assert.match(homePage, /class="content-list__meta">3 hours<\/span>/);
  assert.match(firstPage, /This first sentence becomes the automatic summary\./);
  assert.match(firstPage, /<li>F1<\/li>/);
  assert.match(sectionPage, /<span class="content-list__meta">F1 · 8 minutes · Beginner<\/span>/);
  assert.match(
    firstPage,
    /<ul class="page-tags" aria-label="Tags"><li>reliability<\/li><li>storage<\/li><\/ul>/,
  );
  assert.match(firstPage, /href="\/docs\/foundations\/second\/#second-section"/);
  assert.match(firstPage, /href="\/docs\/_content\/01-foundations\/sample\.txt"/);
  assert.match(firstPage, /class="footnote-ref"/);
  assert.match(firstPage, /This is a short inline footnote\./);
  assert.match(
    firstPage,
    /<section class="footnotes" aria-labelledby="__inkpath-footnotes-label">/,
  );
  assert.match(
    firstPage,
    /<h2 class="visually-hidden" id="__inkpath-footnotes-label">Footnotes<\/h2>/,
  );
  assert.match(firstPage, /aria-label="Footnote 1"/);
  assert.match(firstPage, /aria-label="Footnote 1, occurrence 2"/);
  assert.match(firstPage, /aria-label="Footnote 2"/);
  assert.match(firstPage, /id="fn__inkpath-footnote-1"/);
  assert.match(firstPage, /id="fnref__inkpath-footnote-1"/);
  assert.match(firstPage, /id="fnref__inkpath-footnote-1:1"/);
  assert.match(firstPage, /href="#fnref__inkpath-footnote-1:1"/);
  assert.match(firstPage, /aria-label="Back to footnote reference 1"/);
  assert.match(firstPage, /aria-label="Back to footnote reference 2"/);
  assert.match(
    firstPage,
    /<aside class="annotation annotation--note" role="note" aria-labelledby="__inkpath-annotation-1-label">/,
  );
  assert.match(
    firstPage,
    /<p class="annotation__label" id="__inkpath-annotation-1-label">Note<\/p>/,
  );
  assert.match(firstPage, /<strong>Markdown<\/strong>/);
  assert.match(
    firstPage,
    /<aside class="annotation annotation--warning" role="note" aria-labelledby="__inkpath-annotation-2-label">/,
  );
  assert.match(
    firstPage,
    /<p class="annotation__label" id="__inkpath-annotation-2-label">Warning<\/p>/,
  );
  assert.match(
    firstPage,
    /<aside class="annotation annotation--tip" role="note" aria-labelledby="__inkpath-annotation-3-label">/,
  );
  assert.match(
    firstPage,
    /<p class="annotation__label" id="__inkpath-annotation-3-label">Trace the boundary<\/p>/,
  );
  assert.match(
    firstPage,
    /<details class="annotation annotation--important" role="note" aria-labelledby="__inkpath-annotation-4-label">/,
  );
  assert.match(
    firstPage,
    /<summary class="annotation__label" id="__inkpath-annotation-4-label">Optional detail<\/summary>/,
  );
  assert.doesNotMatch(firstPage, /<details[^>]+open/);
  assert.match(firstPage, /<blockquote>\s*<p>\[!note\]/);
  assert.equal(firstPage.match(/class="annotation annotation--note"/g)?.length, 1);
  assert.match(firstPage, /class="hljs language-ts"/);
  assert.match(firstPage, /&amp;lt;script&amp;gt;|&lt;script&gt;/);
  assert.doesNotMatch(firstPage, /<script>alert/);
  assert.match(firstPage, /data-inkpath-diagram/);
  const mermaidEntry = firstPage.match(/src="\/docs\/_inkpath\/(inkpath-[A-Z0-9]+\.js)"/)?.[1];
  assert.ok(mermaidEntry);
  const mermaidEntrySource = await readFile(path.join(output, "_inkpath", mermaidEntry), "utf8");
  assert.ok(mermaidEntrySource.length < 5_000);
  assert.match(mermaidEntrySource, /import\("\.\/chunks\//);
  const chunks = await readdir(path.join(output, "_inkpath", "chunks"));
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((file) => /-[A-Z0-9]+\.js$/.test(file)));
  const thirdPartyNotices = await readFile(
    path.join(output, "_inkpath", "THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  assert.match(thirdPartyNotices, /mermaid@11\.16\.0/);
  assert.match(thirdPartyNotices, /dompurify@3\.4\.12/);
  assert.doesNotMatch(secondPage, /inkpath-[A-Z0-9]+\.js/);
  assert.match(firstPage, /class="katex"/);
  assert.match(firstPage, /class="katex-display"/);
  assert.match(firstPage, /href="\/docs\/_inkpath\/katex\/katex\.min\.css"/);
  const katex = await packageDetails("katex");
  assert.equal(katex.version, "0.18.0");
  assert.equal(
    await readFile(path.join(output, "_inkpath", "katex", "LICENSE.txt"), "utf8"),
    katex.license,
  );
  assert.doesNotMatch(secondPage, /katex\.min\.css/);
  assert.match(secondPage, /id="repeat"/);
  assert.match(secondPage, /id="repeat-2"/);
  assert.match(
    secondPage,
    /<a class="heading-permalink" href="#repeat-2" aria-label="Permalink to Repeat">#<\/a>/,
  );
  assert.match(secondPage, /The explicit summary wins over the body\./);
  assert.match(
    secondPage,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/docs\/">Home<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/">Foundations<\/a><\/li><\/ol><\/nav>/,
  );
  assert.match(
    sectionPage,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/docs\/">Home<\/a><\/li><\/ol><\/nav>/,
  );
  assert.doesNotMatch(homePage, /aria-label="Breadcrumb"/);
  assert.match(homePage, /<h2 id="content-list-title" class="section-heading">Collections<\/h2>/);
  assert.match(sectionPage, /<h2 id="content-list-title" class="section-heading">Notes<\/h2>/);
  assert.match(secondPage, /<h2 id="page-toc-title">Contents<\/h2>/);
  assert.doesNotMatch(firstPage, /id="page-toc-title"/);
  assert.match(firstPage, /<li><a href="\/docs\/foundations\/">Foundations<\/a><\/li>/);
  assert.match(secondPage, /aria-label="Adjacent notes"/);
  assert.match(
    secondPage,
    /<section class="backlinks"[\s\S]*<ul><li><a href="\/docs\/foundations\/first\/">First note<\/a><\/li><\/ul>/,
  );
  assert.doesNotMatch(secondPage, /<section class="backlinks"[\s\S]*?<span>[\s\S]*?<\/section>/);
  assert.match(firstPage, /<footer class="page-footer">[\s\S]*aria-label="Adjacent notes"/);
  assert.doesNotMatch(homePage, /class="page-footer"/);
  assert.doesNotMatch(sectionPage, /class="page-footer"/);
  assert.doesNotMatch(
    [homePage, sectionPage, firstPage, secondPage].join("\n"),
    /class="page-source"/,
  );
  assert.doesNotMatch(homePage, /class="content-list__meta">\d+ notes<\/span>/);
  assert.doesNotMatch(sectionPage, /<li>\d+ notes<\/li>/);
  assert.doesNotMatch(firstPage, /__inkpath\/events/);
  assert.match(firstPage, /<meta property="og:type" content="article">/);
  assert.match(
    firstPage,
    /<meta property="og:image" content="https:\/\/example\.com\/docs\/favicon\.svg">/,
  );
  assert.match(firstPage, /<meta property="article:tag" content="storage">/);
  assert.match(firstPage, /type="application\/rss\+xml"/);
  assert.match(
    await readFile(path.join(output, "sitemap.xml"), "utf8"),
    /<loc>https:\/\/example\.com\/docs\/foundations\/first\/<\/loc>/,
  );
  assert.match(await readFile(path.join(output, "rss.xml"), "utf8"), /<title>First note<\/title>/);
  assert.match(
    await readFile(path.join(output, "atom.xml"), "utf8"),
    /<author><name>Fixture Author<\/name><\/author>/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output, "_inkpath", "orphans.json"), "utf8")),
    [
      {
        route: "/docs/foundations/first/",
        source: "01-foundations/01-first.md",
        title: "First note",
      },
    ],
  );
  assert.equal(
    await readFile(path.join(output, "_content", "01-foundations", "sample.txt"), "utf8"),
    "plain fixture data\n",
  );
  await readFile(path.join(output, "favicon.svg"), "utf8");
  const theme = await readFile(path.join(output, "_inkpath", "theme.css"), "utf8");
  assert.match(theme, /--reading-width: 43\.75rem/);
  assert.match(theme, /--ink: #171513/);
  assert.match(theme, /--muted: #56534d/);
  assert.match(theme, /--faint: #77736b/);
  assert.match(theme, /--line: #e7e3dc/);
  assert.match(theme, /--willow: #2dd4bf/);
  assert.match(theme, /--accent: var\(--willow\)/);
  assert.match(theme, /--accent-soft: #f0fdfa/);
  assert.match(theme, /--interactive: #0f766e/);
  assert.match(theme, /--interactive-hover: #0b5f59/);
  assert.match(theme, /--inline-code: #f0fdfa/);
  assert.match(theme, /::selection \{\s*background: var\(--willow\);\s*color: var\(--ink\)/);
  assert.match(theme, /a \{\s*color: var\(--interactive\);\s*text-decoration-color: currentColor/);
  assert.match(
    theme,
    /a:hover \{\s*color: var\(--interactive-hover\);\s*text-decoration-color: var\(--willow\)/,
  );
  assert.match(theme, /\.site-logo \{/);
  assert.match(theme, /\.breadcrumbs__separator \{/);
  assert.match(theme, /\.site-brand:hover,\s*\.site-brand:focus-visible \{\s*color: var\(--ink\)/);
  assert.match(
    theme,
    /\.site-brand:hover \.site-title,[\s\S]*background-color: var\(--accent-soft\)/,
  );
  assert.match(theme, /\.content-list__title-text \{[^}]*text-decoration-line: underline/);
  assert.match(
    theme,
    /\.content-list a:hover \.content-list__title-text \{[^}]*text-decoration-color: var\(--willow\)/,
  );
  assert.match(
    theme,
    /\.page-pagination a:hover strong \{\s*text-decoration-color: var\(--willow\)/,
  );
  assert.match(theme, /\.heading-permalink \{/);
  assert.match(theme, /\.backlinks \{/);
  assert.doesNotMatch(theme, /\.backlinks \{[^}]*border-top/);
  assert.doesNotMatch(theme, /\.backlinks span \{/);
  assert.match(theme, /details\.annotation/);
  assert.doesNotMatch(
    theme,
    /\.content-list a:hover \.content-list__title-text[^}]*background-color/,
  );

  const hashesBefore = await outputHashes(output);
  await buildSite(project, { commitSha });
  assert.deepEqual(await outputHashes(output), hashesBefore);
});

test("keeps the default mark when a logo is not configured", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(config, (await readFile(config, "utf8")).replace("  logo: favicon.svg\n", ""));

  await buildSite(project);
  const html = await readFile(path.join(project, "site", "index.html"), "utf8");
  assert.match(html, /<span class="site-mark" aria-hidden="true">/);
  assert.doesNotMatch(html, /class="site-logo"/);
});

test("emits licenses for exactly the generated browser assets", async (t) => {
  async function removeMermaid(project: string): Promise<void> {
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace(/```mermaid[\s\S]*?```\n?/, ""));
  }

  async function disableMath(project: string): Promise<void> {
    const config = path.join(project, "inkpath.yaml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace("markdown:\n  math: true\n", ""),
    );
  }

  await t.test("math only", async () => {
    const project = await copyFixture();
    await removeMermaid(project);
    const result = await buildSite(project);
    assert.equal(result.diagrams, 0);
    assert.equal(result.math, 2);

    const assets = path.join(project, "site", "_inkpath");
    const katex = await packageDetails("katex");
    assert.equal(katex.version, "0.18.0");
    assert.equal(await readFile(path.join(assets, "katex", "LICENSE.txt"), "utf8"), katex.license);
    await access(path.join(assets, "katex", "katex.min.css"));
    await assert.rejects(access(path.join(assets, "THIRD_PARTY_NOTICES.txt")));
    assert.equal(
      (await readdir(assets)).some((file) => /^inkpath-[A-Z0-9]+\.js$/.test(file)),
      false,
    );
  });

  await t.test("Mermaid only", async () => {
    const project = await copyFixture();
    await disableMath(project);
    const result = await buildSite(project);
    assert.equal(result.diagrams, 1);
    assert.equal(result.math, 0);

    const assets = path.join(project, "site", "_inkpath");
    const mermaid = await packageDetails("mermaid");
    const notices = await readFile(path.join(assets, "THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.match(notices, new RegExp(`mermaid@${mermaid.version.replaceAll(".", "\\.")}`));
    assert.ok(notices.includes(mermaid.license.trim()));
    await assert.rejects(access(path.join(assets, "katex")));
  });

  await t.test("both", async () => {
    const project = await copyFixture();
    const result = await buildSite(project);
    assert.equal(result.diagrams, 1);
    assert.equal(result.math, 2);

    const assets = path.join(project, "site", "_inkpath");
    await access(path.join(assets, "THIRD_PARTY_NOTICES.txt"));
    await access(path.join(assets, "katex", "LICENSE.txt"));
  });

  await t.test("neither", async () => {
    const project = await copyFixture();
    await removeMermaid(project);
    await disableMath(project);
    const result = await buildSite(project);
    assert.equal(result.diagrams, 0);
    assert.equal(result.math, 0);

    const assets = path.join(project, "site", "_inkpath");
    await assert.rejects(access(path.join(assets, "THIRD_PARTY_NOTICES.txt")));
    await assert.rejects(access(path.join(assets, "katex")));
    await assert.rejects(access(path.join(assets, "chunks")));
    assert.equal(
      (await readdir(assets)).some((file) => /^inkpath-[A-Z0-9]+\.js$/.test(file)),
      false,
    );
  });
});

test("keeps static math optional and rejects invalid expressions", async (t) => {
  await t.test("disabled", async () => {
    const project = await copyFixture();
    const config = path.join(project, "inkpath.yaml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace("markdown:\n  math: true\n", ""),
    );
    const result = await buildSite(project);
    assert.equal(result.math, 0);
    const html = await readFile(
      path.join(project, "site", "foundations", "first", "index.html"),
      "utf8",
    );
    assert.doesNotMatch(html, /class="katex"/);
    assert.doesNotMatch(html, /katex\.min\.css/);
    await assert.rejects(access(path.join(project, "site", "_inkpath", "katex")));
  });

  await t.test("invalid expression", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("c = a + b", "\\notACommand{"));
    await assert.rejects(buildSite(project), /invalid KaTeX expression/);
  });
});

test("supports callouts that start expanded", async () => {
  const project = await copyFixture();
  const note = path.join(project, "content", "01-foundations", "02-second.md");
  await writeFile(
    note,
    `${await readFile(note, "utf8")}\n\n> [!CAUTION]+ Expanded title\n> Expanded content.\n`,
  );
  await buildSite(project);
  const html = await readFile(
    path.join(project, "site", "foundations", "second", "index.html"),
    "utf8",
  );
  assert.match(
    html,
    /<details class="annotation annotation--caution" role="note" aria-labelledby="__inkpath-annotation-1-label" open="">/,
  );
  assert.match(html, />Expanded title<\/summary>/);
});

test("validates discovery and Markdown configuration", async (t) => {
  for (const url of [
    "notes.example.com",
    "ftp://example.com",
    "https://user@example.com",
    "https://example.com/notes",
  ]) {
    await t.test(`site.url ${url}`, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(config, (await readFile(config, "utf8")).replace("https://example.com", url));
      await assert.rejects(
        buildSite(project),
        /site\.url must be an absolute HTTP or HTTPS (?:URL|origin)/,
      );
    });
  }

  await t.test("markdown.math", async () => {
    const project = await copyFixture();
    const config = path.join(project, "inkpath.yaml");
    await writeFile(config, (await readFile(config, "utf8")).replace("math: true", "math: yes"));
    await assert.rejects(buildSite(project), /markdown\.math must be true or false/);
  });

  await t.test("site mapping", async () => {
    const project = await copyFixture();
    const config = path.join(project, "inkpath.yaml");
    await writeFile(config, "site: Inkpath\n");
    await assert.rejects(buildSite(project), /site must be a YAML mapping/);
  });

  await t.test("site without a public URL", async () => {
    const project = await copyFixture();
    const config = path.join(project, "inkpath.yaml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace("  url: https://example.com\n", ""),
    );
    await buildSite(project);
    const output = path.join(project, "site");
    const html = await readFile(path.join(output, "index.html"), "utf8");
    assert.doesNotMatch(html, /property="og:/);
    await assert.rejects(access(path.join(output, "sitemap.xml")));
    await assert.rejects(access(path.join(output, "rss.xml")));
    await assert.rejects(access(path.join(output, "atom.xml")));
  });
});

test("rejects unknown configuration keys with source-specific suggestions", async (t) => {
  const cases = [
    {
      name: "root",
      update: (source: string) => `${source}\ncontnet: notes\n`,
      expected: /inkpath\.yaml: unknown configuration key "contnet"\. Did you mean "content"\?/,
    },
    {
      name: "site",
      update: (source: string) => source.replace("basePath: /docs", "basepath: /docs"),
      expected: /inkpath\.yaml: unknown site key "basepath"\. Did you mean "basePath"\?/,
    },
    {
      name: "markdown",
      update: (source: string) => source.replace("math: true", "maths: true"),
      expected: /inkpath\.yaml: unknown markdown key "maths"\. Did you mean "math"\?/,
    },
    {
      name: "theme page details",
      update: (source: string) => `${source}\ntheme:\n  showPageDetail: false\n`,
      expected:
        /inkpath\.yaml: unknown theme key "showPageDetail"\. Did you mean "showPageDetails"\?/,
    },
    {
      name: "theme list details",
      update: (source: string) => `${source}\ntheme:\n  showListDetail: false\n`,
      expected:
        /inkpath\.yaml: unknown theme key "showListDetail"\. Did you mean "showListDetails"\?/,
    },
    {
      name: "theme interactive hover",
      update: (source: string) => `${source}\ntheme:\n  interactiveHove: "#0b5f59"\n`,
      expected:
        /inkpath\.yaml: unknown theme key "interactiveHove"\. Did you mean "interactiveHover"\?/,
    },
  ] as const;

  for (const example of cases) {
    await t.test(example.name, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(config, example.update(await readFile(config, "utf8")));
      await assert.rejects(loadConfig(project), example.expected);
    });
  }
});

test("rejects unknown frontmatter keys and explains the obsolete number key", async (t) => {
  await t.test("misspelling", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(
      note,
      (await readFile(note, "utf8")).replace(
        "title: First note",
        "title: First note\ndescripton: Typo",
      ),
    );
    await assert.rejects(
      buildSite(project),
      /01-foundations\/01-first\.md: unknown frontmatter key "descripton"\. Did you mean "description"\?/,
    );
  });

  await t.test("obsolete number", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(
      note,
      (await readFile(note, "utf8")).replace("identifier: F1", "identifier: F1\nnumber: F1"),
    );
    await assert.rejects(
      buildSite(project),
      /01-foundations\/01-first\.md: unknown frontmatter key "number"\.[\s\S]*use "identifier" for display text or "order" for navigation/,
    );
  });
});

test("requires site.basePath to be a safe normalized URL path", async (t) => {
  const invalidPaths = [
    "notes",
    "/notes/",
    "//notes",
    "/notes//v1",
    "/notes/./v1",
    "/notes/%2e%2e/v1",
    "/notes?draft=1",
    "/notes#intro",
    "/notes/%ZZ",
    "/notes\\admin",
    "/notes/%2Fadmin",
    "/notes/%5cadmin",
    "/notes/%00",
    "/notes/<admin>",
  ];

  for (const basePath of invalidPaths) {
    await t.test(basePath, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          "basePath: /docs",
          `basePath: ${JSON.stringify(basePath)}`,
        ),
      );
      await assert.rejects(
        loadConfig(project),
        /site\.basePath must be \/ or a normalized URL path such as \/notes/,
      );
    });
  }

  await t.test("accepts nested and percent-encoded segments", async () => {
    const project = await copyFixture();
    const config = path.join(project, "inkpath.yaml");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace("basePath: /docs", "basePath: /notes/v1/%E2%9C%93"),
    );
    assert.equal((await loadConfig(project)).site.basePath, "/notes/v1/%E2%9C%93");
  });
});

test("rejects unsafe or missing logo paths", async (t) => {
  for (const value of [
    "../favicon.svg",
    "/favicon.svg",
    "https://example.com/logo.svg",
    "missing.svg",
  ]) {
    await t.test(value, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace("  logo: favicon.svg", `  logo: ${value}`),
      );
      await assert.rejects(
        buildSite(project),
        /site\.logo (?:must be a relative path inside public|does not exist in public)/,
      );
    });
  }
});

test("supports a constrained site accent palette", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  accent: "#38bdf8"\n  interactive: "#075985"\n  interactiveHover: "#0c4a6e"\n  subtle: "#f0f9ff"\n`,
  );

  await buildSite(project);
  const theme = await readFile(path.join(project, "site", "_inkpath", "theme.css"), "utf8");
  assert.match(theme, /--willow: #38bdf8/);
  assert.match(theme, /--accent: var\(--willow\)/);
  assert.match(theme, /--accent-soft: #f0f9ff/);
  assert.match(theme, /--interactive: #075985/);
  assert.match(theme, /--interactive-hover: #0c4a6e/);
  assert.match(theme, /--inline-code: #f0f9ff/);
});

test("uses a custom interactive color on hover when no hover color is set", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(config, `${await readFile(config, "utf8")}\ntheme:\n  interactive: "#075985"\n`);

  const loaded = await loadConfig(project);
  assert.equal(loaded.theme.interactive, "#075985");
  assert.equal(loaded.theme.interactiveHover, "#075985");
});

test("can hide page details without hiding list details", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  showListDetails: true\n  showPageDetails: false\n`,
  );

  await buildSite(project);
  const output = path.join(project, "site");
  const firstPage = await readFile(path.join(output, "foundations", "first", "index.html"), "utf8");
  const sectionPage = await readFile(path.join(output, "foundations", "index.html"), "utf8");
  const homePage = await readFile(path.join(output, "index.html"), "utf8");

  assert.match(firstPage, /aria-label="Breadcrumb"/);
  assert.match(sectionPage, /aria-label="Breadcrumb"/);
  assert.doesNotMatch(firstPage, /<li>F1<\/li>/);
  assert.doesNotMatch(firstPage, /<li>8 minutes<\/li>/);
  assert.doesNotMatch(firstPage, /<li>Beginner<\/li>/);
  assert.doesNotMatch(firstPage, /class="page-tags"/);
  assert.match(homePage, /class="content-list__meta">3 hours<\/span>/);
  assert.match(sectionPage, /class="content-list__meta">F1 · 8 minutes · Beginner<\/span>/);
  assert.match(firstPage, /<meta property="article:tag" content="storage">/);
});

test("can hide list details without hiding page details", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  showListDetails: false\n  showPageDetails: true\n`,
  );

  await buildSite(project);
  const output = path.join(project, "site");
  const firstPage = await readFile(path.join(output, "foundations", "first", "index.html"), "utf8");
  const sectionPage = await readFile(path.join(output, "foundations", "index.html"), "utf8");
  const homePage = await readFile(path.join(output, "index.html"), "utf8");

  assert.match(firstPage, /aria-label="Breadcrumb"/);
  assert.match(firstPage, /<li>F1<\/li>/);
  assert.match(firstPage, /<li>8 minutes<\/li>/);
  assert.match(firstPage, /<li>Beginner<\/li>/);
  assert.match(firstPage, /class="page-tags"/);
  assert.doesNotMatch(homePage, /class="content-list__meta"/);
  assert.doesNotMatch(sectionPage, /class="content-list__meta"/);
});

test("keeps the previous combined metadata behavior when list details are omitted", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(config, `${await readFile(config, "utf8")}\ntheme:\n  showPageDetails: false\n`);

  await buildSite(project);
  const output = path.join(project, "site");
  const firstPage = await readFile(path.join(output, "foundations", "first", "index.html"), "utf8");
  const sectionPage = await readFile(path.join(output, "foundations", "index.html"), "utf8");
  const homePage = await readFile(path.join(output, "index.html"), "utf8");

  assert.match(firstPage, /aria-label="Breadcrumb"/);
  assert.doesNotMatch(firstPage, /<li>F1<\/li>/);
  assert.doesNotMatch(firstPage, /class="page-tags"/);
  assert.doesNotMatch(homePage, /class="content-list__meta"/);
  assert.doesNotMatch(sectionPage, /class="content-list__meta"/);
});

test("rejects an invalid page-details setting", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  showPageDetails: "false"\n`,
  );

  await assert.rejects(loadConfig(project), /theme\.showPageDetails must be true or false/);
});

test("rejects an invalid list-details setting", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  showListDetails: "false"\n`,
  );

  await assert.rejects(loadConfig(project), /theme\.showListDetails must be true or false/);
});

test("uses a project-owned stylesheet instead of the generated theme", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  const output = path.join(project, "site");
  await buildSite(project);
  await access(path.join(output, "_inkpath", "theme.css"));

  const stylesheet = path.join(project, "public", "styles", "notes.css");
  await mkdir(path.dirname(stylesheet), { recursive: true });
  await writeFile(stylesheet, ":root { --ink: #102a2a; }\n", "utf8");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  stylesheet: styles/notes.css\n`,
  );

  await buildSite(project);
  const home = await readFile(path.join(output, "index.html"), "utf8");
  const notFound = await readFile(path.join(output, "404.html"), "utf8");
  assert.match(home, /href="\/docs\/styles\/notes\.css"/);
  assert.match(notFound, /href="\/docs\/styles\/notes\.css"/);
  assert.equal(
    await readFile(path.join(output, "styles", "notes.css"), "utf8"),
    ":root { --ink: #102a2a; }\n",
  );
  await assert.rejects(access(path.join(output, "_inkpath", "theme.css")));
  assert.ok(
    (await readdir(path.join(output, "_inkpath"))).some((file) =>
      /^inkpath-[A-Z0-9]+\.js$/.test(file),
    ),
  );
});

test("rejects unsafe or invalid project-owned stylesheets", async (t) => {
  for (const [value, expected] of [
    ["../notes.css", /theme\.stylesheet must be a relative path inside public/],
    ["/notes.css", /theme\.stylesheet must be a relative path inside public/],
    ["https://example.com/notes.css", /theme\.stylesheet must be a relative path inside public/],
    [".styles/notes.css", /theme\.stylesheet must be a relative path inside public/],
    ["missing.css", /theme\.stylesheet does not exist in public/],
    ["favicon.svg", /theme\.stylesheet must point to a CSS file in public/],
  ] as const) {
    await t.test(value, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(
        config,
        `${await readFile(config, "utf8")}\ntheme:\n  stylesheet: ${JSON.stringify(value)}\n`,
      );
      await assert.rejects(buildSite(project), expected);
    });
  }
});

test("rejects theme colors alongside a project-owned stylesheet", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(path.join(project, "public", "notes.css"), "body {}\n", "utf8");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  stylesheet: notes.css\n  interactiveHover: "#0b5f59"\n`,
  );

  await assert.rejects(
    buildSite(project),
    /theme\.stylesheet cannot be combined with theme color settings/,
  );
});

test("loadConfig rejects a stylesheet reached through a symbolic link", async () => {
  const project = await copyFixture();
  const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-stylesheet-"));
  await writeFile(path.join(external, "notes.css"), "body {}\n", "utf8");
  await symlink(external, path.join(project, "public", "styles"), "dir");
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  stylesheet: styles/notes.css\n`,
  );

  await assert.rejects(loadConfig(project), /theme\.stylesheet must be a regular file in public/);
});

test("rejects unsafe theme color values", async (t) => {
  for (const value of ["red", "#fff", "url(https://example.com)", "#0f766e; color: red"]) {
    await t.test(value, async () => {
      const project = await copyFixture();
      const config = path.join(project, "inkpath.yaml");
      await writeFile(
        config,
        `${await readFile(config, "utf8")}\ntheme:\n  accent: ${JSON.stringify(value)}\n`,
      );
      await assert.rejects(
        buildSite(project),
        /theme\.accent must be a six-digit hexadecimal color/,
      );
    });
  }
});

test("rejects an unsafe interactive hover color", async () => {
  const project = await copyFixture();
  const config = path.join(project, "inkpath.yaml");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\ntheme:\n  interactiveHover: "teal"\n`,
  );
  await assert.rejects(
    buildSite(project),
    /theme\.interactiveHover must be a six-digit hexadecimal color/,
  );
});

test("keeps generated footnote identifiers separate from heading identifiers", async () => {
  const project = await copyFixture();
  const note = path.join(project, "content", "01-foundations", "01-first.md");
  await writeFile(
    note,
    `${await readFile(note, "utf8")}\n## fn1\n\nA heading that resembles a footnote item.\n\n## fnref1\n\nA heading that resembles a footnote reference.\n`,
  );

  await buildSite(project);
  const html = await readFile(
    path.join(project, "site", "foundations", "first", "index.html"),
    "utf8",
  );
  assert.match(html, /<h2 id="fn1"/);
  assert.match(html, /<h2 id="fnref1"/);
  assert.match(html, /id="fn__inkpath-footnote-1"/);
  assert.match(html, /id="fnref__inkpath-footnote-1"/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("supports arbitrarily nested sections, lists, links, and local pagination", async () => {
  const project = await copyFixture();
  const content = path.join(project, "content");
  const layerOne = path.join(content, "01-foundations", "03-layer-one");
  const layerTwo = path.join(layerOne, "02-layer-two");
  const layerThree = path.join(layerTwo, "01-layer-three");
  const branch = path.join(layerThree, "02-branch");
  await mkdir(branch, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(layerOne, "INDEX.md"),
      "---\ntitle: Layer one\ndescription: First nested section.\nslug: layer-one\norder: 3\n---\n\nFirst layer.\n",
    ),
    writeFile(
      path.join(layerTwo, "INDEX.md"),
      "---\ntitle: Layer two\ndescription: Second nested section.\nslug: middle\norder: 2\n---\n\nSecond layer.\n",
    ),
    writeFile(
      path.join(layerThree, "INDEX.md"),
      "---\ntitle: Layer three\ndescription: Third nested section.\nslug: leaf\norder: 1\n---\n\nThird layer.\n",
    ),
    writeFile(
      path.join(branch, "INDEX.md"),
      "---\ntitle: Side branch\ndescription: A nested sibling between two notes.\norder: 2\n---\n\nAn empty nested section.\n",
    ),
    writeFile(
      path.join(layerThree, "01-alpha.md"),
      "---\ntitle: Alpha\ndescription: First deeply nested note.\norder: 1\nidentifier: D1\n---\n\n- Layer one\n  - Layer two\n    - Layer three\n      - Layer four\n\nRead [Beta](03-beta.md#details), the [parent](../INDEX.md), the [home page](../../../../INDEX.md), and the [local asset](diagram.txt).\n",
    ),
    writeFile(
      path.join(layerThree, "03-beta.md"),
      "---\ntitle: Beta\ndescription: Second deeply nested note.\norder: 3\nidentifier: D2\n---\n\n## Details\n\nThe target fragment is stable.\n",
    ),
    writeFile(path.join(layerThree, "diagram.txt"), "deep asset\n"),
  ]);

  const result = await buildSite(project);
  const one = result.site.pageBySource.get("01-foundations/03-layer-one/INDEX.md");
  const two = result.site.pageBySource.get("01-foundations/03-layer-one/02-layer-two/INDEX.md");
  const three = result.site.pageBySource.get(
    "01-foundations/03-layer-one/02-layer-two/01-layer-three/INDEX.md",
  );
  const sideBranch = result.site.pageBySource.get(
    "01-foundations/03-layer-one/02-layer-two/01-layer-three/02-branch/INDEX.md",
  );
  const alpha = result.site.pageBySource.get(
    "01-foundations/03-layer-one/02-layer-two/01-layer-three/01-alpha.md",
  );
  const beta = result.site.pageBySource.get(
    "01-foundations/03-layer-one/02-layer-two/01-layer-three/03-beta.md",
  );
  assert.ok(one && two && three && sideBranch && alpha && beta);
  assert.equal(one.parent?.title, "Foundations");
  assert.equal(two.parent, one);
  assert.equal(three.parent, two);
  assert.equal(sideBranch.parent, three);
  assert.equal(alpha.parent, three);
  assert.equal(beta.parent, three);
  assert.equal(alpha.depth, 5);
  assert.deepEqual(
    three.children.map((page) => page.title),
    ["Alpha", "Side branch", "Beta"],
  );
  assert.deepEqual(
    result.site.sections.map((page) => page.title),
    ["Foundations"],
  );
  assert.deepEqual(
    navigationPages(result.site)
      .slice(-2)
      .map((page) => page.title),
    ["Alpha", "Beta"],
  );

  const output = path.join(project, "site");
  const foundationsHtml = await readFile(path.join(output, "foundations", "index.html"), "utf8");
  const oneHtml = await readFile(
    path.join(output, "foundations", "layer-one", "index.html"),
    "utf8",
  );
  const twoHtml = await readFile(
    path.join(output, "foundations", "layer-one", "middle", "index.html"),
    "utf8",
  );
  const threeHtml = await readFile(
    path.join(output, "foundations", "layer-one", "middle", "leaf", "index.html"),
    "utf8",
  );
  const alphaHtml = await readFile(
    path.join(output, "foundations", "layer-one", "middle", "leaf", "alpha", "index.html"),
    "utf8",
  );
  const betaHtml = await readFile(
    path.join(output, "foundations", "layer-one", "middle", "leaf", "beta", "index.html"),
    "utf8",
  );
  assert.match(foundationsHtml, /href="\/docs\/foundations\/layer-one\/"/);
  assert.doesNotMatch(foundationsHtml, /href="\/docs\/foundations\/layer-one\/middle\/"/);
  assert.match(oneHtml, /<h2 id="content-list-title" class="section-heading">Notes<\/h2>/);
  assert.match(oneHtml, /href="\/docs\/foundations\/layer-one\/middle\/"/);
  assert.doesNotMatch(oneHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/"/);
  assert.match(twoHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/"/);
  assert.match(
    twoHtml,
    /<section class="backlinks"[\s\S]*href="\/docs\/foundations\/layer-one\/middle\/leaf\/alpha\/"/,
  );
  assert.match(threeHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/alpha\/"/);
  assert.match(threeHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/branch\/"/);
  assert.match(threeHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/beta\/"/);
  assert.match(
    threeHtml,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/docs\/">Home<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/">Foundations<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/layer-one\/">Layer one<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/layer-one\/middle\/">Layer two<\/a><\/li><\/ol><\/nav>/,
  );
  assert.match(
    alphaHtml,
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="\/docs\/">Home<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/">Foundations<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/layer-one\/">Layer one<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/layer-one\/middle\/">Layer two<\/a><span class="breadcrumbs__separator" aria-hidden="true">\/<\/span><\/li><li><a href="\/docs\/foundations\/layer-one\/middle\/leaf\/">Layer three<\/a><\/li><\/ol><\/nav>/,
  );
  assert.equal(alphaHtml.match(/aria-label="Breadcrumb"/g)?.length, 1);
  assert.match(alphaHtml, /<li>Layer one\s*<ul>[\s\S]*<li>Layer four<\/li>/);
  assert.match(alphaHtml, /href="\/docs\/foundations\/layer-one\/middle\/leaf\/beta\/#details"/);
  assert.match(alphaHtml, /href="\/docs\/foundations\/layer-one\/middle\/"/);
  assert.match(alphaHtml, /href="\/docs\/"/);
  assert.match(
    alphaHtml,
    /href="\/docs\/_content\/01-foundations\/03-layer-one\/02-layer-two\/01-layer-three\/diagram\.txt"/,
  );
  assert.match(alphaHtml, /rel="next" href="\/docs\/foundations\/layer-one\/middle\/leaf\/beta\/"/);
  assert.match(betaHtml, /rel="prev" href="\/docs\/foundations\/layer-one\/middle\/leaf\/alpha\/"/);
  assert.equal(
    await readFile(
      path.join(
        output,
        "_content",
        "01-foundations",
        "03-layer-one",
        "02-layer-two",
        "01-layer-three",
        "diagram.txt",
      ),
      "utf8",
    ),
    "deep asset\n",
  );
});

test("requires INDEX.md for every directory with published Markdown", async (t) => {
  await t.test("missing intermediate overview", async () => {
    const project = await copyFixture();
    const deep = path.join(project, "content", "01-foundations", "03-unindexed", "01-deep");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "INDEX.md"), "---\ntitle: Deep\n---\n\nVisible content.\n");
    await assert.rejects(
      buildSite(project),
      /01-foundations\/03-unindexed: published Markdown directories need an INDEX\.md/,
    );
  });

  await t.test("draft section with a published note", async () => {
    const project = await copyFixture();
    const directory = path.join(project, "content", "01-foundations", "03-draft-section");
    await mkdir(directory);
    await writeFile(
      path.join(directory, "INDEX.md"),
      "---\ntitle: Draft\ndraft: true\n---\n\nHidden overview.\n",
    );
    await writeFile(
      path.join(directory, "01-visible.md"),
      "---\ntitle: Visible\n---\n\nPublished note.\n",
    );
    await assert.rejects(
      buildSite(project),
      /01-foundations\/03-draft-section: published Markdown directories need an INDEX\.md/,
    );
  });

  await t.test("asset-only directory", async () => {
    const project = await copyFixture();
    const directory = path.join(project, "content", "01-foundations", "assets");
    await mkdir(directory);
    await writeFile(path.join(directory, "data.json"), "{}\n");
    await buildSite(project);
    assert.equal(
      await readFile(
        path.join(project, "site", "_content", "01-foundations", "assets", "data.json"),
        "utf8",
      ),
      "{}\n",
    );
  });
});

test("removes footnote syntax from automatic summaries", async (t) => {
  const cases = [
    {
      name: "inline footnote",
      paragraph:
        "An inline claim.^[See [details](https://example.com/guide) for context.] A second sentence.",
      summary: "An inline claim.",
    },
    {
      name: "named footnote",
      paragraph:
        "A named claim.[^context] A second sentence.\n\n[^context]: Context that belongs below the note.",
      summary: "A named claim.",
    },
    {
      name: "undefined footnote-like text",
      paragraph: "A literal [^missing] marker stays. A second sentence.",
      summary: "A literal [^missing] marker stays.",
    },
    {
      name: "footnote syntax in code",
      paragraph: "The literal syntax is `^[not a footnote]` and `[^missing]`. A second sentence.",
      summary: "The literal syntax is ^[not a footnote] and [^missing].",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const project = await copyFixture();
      const note = path.join(project, "content", "01-foundations", "01-first.md");
      const source = await readFile(note, "utf8");
      await writeFile(
        note,
        source.replace(
          "This first sentence becomes the automatic summary. A second sentence should not be required.",
          fixture.paragraph,
        ),
      );

      const result = await buildSite(project, { write: false });
      assert.equal(
        result.site.pageBySource.get("01-foundations/01-first.md")?.summary,
        fixture.summary,
      );
    });
  }
});

test("uses INDEX.md as the content overview convention", async (t) => {
  await t.test("requires a root INDEX.md", async () => {
    const project = await copyFixture();
    await rm(path.join(project, "content", "INDEX.md"));
    await assert.rejects(buildSite(project, { write: false }), /content needs a root INDEX\.md/);
  });

  await t.test("rejects a legacy README.md overview", async () => {
    const project = await copyFixture();
    await rename(
      path.join(project, "content", "INDEX.md"),
      path.join(project, "content", "README.md"),
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /README\.md: content overview files must be named INDEX\.md, not README\.md/,
    );
  });

  await t.test("rejects two case variants where the filesystem permits them", async (caseTest) => {
    const project = await copyFixture();
    const content = path.join(project, "content");
    await writeFile(
      path.join(content, "index.md"),
      await readFile(path.join(content, "INDEX.md"), "utf8"),
    );
    const variants = (await readdir(content)).filter((entry) => entry.toLowerCase() === "index.md");
    if (variants.length < 2) {
      caseTest.skip("filesystem is case-insensitive");
      return;
    }
    await assert.rejects(
      buildSite(project, { write: false }),
      /content: use only one INDEX\.md per directory/,
    );
  });
});

test("fails on missing documents, fragments, and assets", async (t) => {
  await t.test("missing Markdown document", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(
      note,
      (await readFile(note, "utf8")).replace("02-second.md#second-section", "missing.md"),
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /missing Markdown link target missing\.md/,
    );
  });

  await t.test("missing fragment", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(
      note,
      (await readFile(note, "utf8")).replace("#second-section", "#missing-section"),
    );
    await assert.rejects(buildSite(project, { write: false }), /missing anchor #missing-section/);
  });

  await t.test("missing asset", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("sample.txt", "missing.txt"));
    await assert.rejects(
      buildSite(project, { write: false }),
      /missing local asset 01-foundations\/missing\.txt/,
    );
  });

  await t.test("hidden asset", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(path.join(project, "content", "01-foundations", ".hidden.txt"), "hidden\n");
    await writeFile(note, (await readFile(note, "utf8")).replace("sample.txt", ".hidden.txt"));
    await assert.rejects(
      buildSite(project, { write: false }),
      /hidden local assets are not supported/,
    );
  });
});

test("rejects unsafe or inaccessible Mermaid diagrams", async (t) => {
  await t.test("missing accessible description", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace(/^  accDescr:.*\n/m, ""));
    await assert.rejects(buildSite(project, { write: false }), /need accTitle and accDescr/);
  });

  await t.test("click directive", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(
      note,
      (await readFile(note, "utf8")).replace(
        "  client[Client]",
        '  click client "javascript:alert(1)"\n  client[Client]',
      ),
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /click directives are not supported/,
    );
  });
});

test("rejects overlapping or symbolic-link project paths", async (t) => {
  await t.test("content inside output", async () => {
    const project = await copyFixture();
    await mkdir(path.join(project, "site", "..content"), { recursive: true });
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: site/..content\noutput: site\npublic: public\n",
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /content and output directories cannot overlap/,
    );
  });

  await t.test("public equal to content", async () => {
    const project = await copyFixture();
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: content\noutput: site\npublic: content\n",
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /content and public directories cannot overlap/,
    );
  });

  await t.test("content root symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await rm(path.join(project, "content"), { recursive: true });
    await symlink(external, path.join(project, "content"), "dir");
    await assert.rejects(
      buildSite(project, { write: false }),
      /content cannot be or pass through a symbolic link/,
    );
  });

  await t.test("intermediate symbolic link", async () => {
    const project = await copyFixture();
    await mkdir(path.join(project, "real"), { recursive: true });
    await cp(path.join(project, "content"), path.join(project, "real", "notes"), {
      recursive: true,
    });
    await symlink(path.join(project, "real"), path.join(project, "alias"), "dir");
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: alias/notes\noutput: real\npublic: public\n",
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /content cannot be or pass through a symbolic link/,
    );
  });

  await t.test("nested public symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await symlink(external, path.join(project, "public", "escape"), "dir");
    await assert.rejects(
      buildSite(project, { write: false }),
      /public cannot contain symbolic links/,
    );
  });

  await t.test("hidden content symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await symlink(external, path.join(project, "content", ".hidden"), "dir");
    await assert.rejects(
      buildSite(project, { write: false }),
      /content cannot contain symbolic links/,
    );
  });

  await t.test("case-insensitive aliases", async (caseTest) => {
    const project = await copyFixture();
    const canonical = path.join(project, "CaseContent");
    const alias = path.join(project, "casecontent");
    await cp(path.join(project, "content"), canonical, { recursive: true });
    try {
      await realpath(alias);
    } catch {
      caseTest.skip("filesystem is case-sensitive");
      return;
    }
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: CaseContent\noutput: casecontent/site\npublic: public\n",
    );
    await assert.rejects(
      buildSite(project, { write: false }),
      /content and output directories cannot overlap/,
    );
  });
});

test("never treats legacy scratch directory names as disposable", async (t) => {
  for (const name of [".site.inkpath-stage", ".site.inkpath-previous"]) {
    await t.test(name, async () => {
      const project = await copyFixture();
      const content = path.join(project, name);
      await cp(path.join(project, "content"), content, { recursive: true });
      await writeFile(
        path.join(project, "inkpath.yaml"),
        `content: ${name}\noutput: site\npublic: public\n`,
      );

      await buildSite(project);
      await buildSite(project);
      assert.match(await readFile(path.join(content, "INDEX.md"), "utf8"), /Fixture notes/);
      const entries = await readdir(project);
      assert.equal(
        entries.some((entry) => entry.startsWith(".site.inkpath-stage-")),
        false,
      );
      assert.equal(
        entries.some((entry) => entry.startsWith(".site.inkpath-previous-")),
        false,
      );
    });
  }
});

test("preserves unrelated legacy scratch sentinels", async () => {
  const project = await copyFixture();
  for (const name of [".site.inkpath-stage", ".site.inkpath-previous"]) {
    await mkdir(path.join(project, name));
    await writeFile(path.join(project, name, "sentinel.txt"), `${name}\n`);
  }
  await buildSite(project);
  for (const name of [".site.inkpath-stage", ".site.inkpath-previous"]) {
    assert.equal(await readFile(path.join(project, name, "sentinel.txt"), "utf8"), `${name}\n`);
  }
});
