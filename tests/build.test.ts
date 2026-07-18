import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "../src/build.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

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
        hashes.set(relative, createHash("sha256").update(await readFile(entryPath)).digest("hex"));
      }
    }
  };
  await visit(root);
  return hashes;
}

test("builds deterministic static pages with the complete Markdown surface", async () => {
  const project = await copyFixture();
  const firstBuild = await buildSite(project);
  assert.equal(firstBuild.pages, 4);
  assert.equal(firstBuild.diagrams, 1);

  const output = path.join(project, "site");
  const firstPage = await readFile(path.join(output, "foundations", "first", "index.html"), "utf8");
  const secondPage = await readFile(path.join(output, "foundations", "second", "index.html"), "utf8");
  const homePage = await readFile(path.join(output, "index.html"), "utf8");

  assert.match(homePage, /Fixture notes/);
  assert.match(homePage, /Small examples of the supported Markdown surface/);
  assert.match(firstPage, /This first sentence becomes the automatic summary\./);
  assert.match(firstPage, /href="\/docs\/foundations\/second\/#second-section"/);
  assert.match(firstPage, /href="\/docs\/_content\/01-foundations\/sample\.txt"/);
  assert.match(firstPage, /class="footnote-ref"/);
  assert.match(firstPage, /This is a short inline footnote\./);
  assert.match(firstPage, /<section class="footnotes" aria-labelledby="__inkpath-footnotes-label">/);
  assert.match(firstPage, /<h2 class="visually-hidden" id="__inkpath-footnotes-label">Footnotes<\/h2>/);
  assert.match(firstPage, /aria-label="Footnote 1"/);
  assert.match(firstPage, /aria-label="Footnote 1, occurrence 2"/);
  assert.match(firstPage, /aria-label="Footnote 2"/);
  assert.match(firstPage, /id="fn__inkpath-footnote-1"/);
  assert.match(firstPage, /id="fnref__inkpath-footnote-1"/);
  assert.match(firstPage, /id="fnref__inkpath-footnote-1:1"/);
  assert.match(firstPage, /href="#fnref__inkpath-footnote-1:1"/);
  assert.match(firstPage, /aria-label="Back to footnote reference 1"/);
  assert.match(firstPage, /aria-label="Back to footnote reference 2"/);
  assert.match(firstPage, /<aside class="annotation annotation--note" role="note" aria-labelledby="__inkpath-annotation-1-label">/);
  assert.match(firstPage, /<p class="annotation__label" id="__inkpath-annotation-1-label">Note<\/p>/);
  assert.match(firstPage, /<strong>Markdown<\/strong>/);
  assert.match(firstPage, /<aside class="annotation annotation--warning" role="note" aria-labelledby="__inkpath-annotation-2-label">/);
  assert.match(firstPage, /<p class="annotation__label" id="__inkpath-annotation-2-label">Warning<\/p>/);
  assert.match(firstPage, /<blockquote>\s*<p>\[!note\]/);
  assert.equal(firstPage.match(/class="annotation annotation--note"/g)?.length, 1);
  assert.match(firstPage, /class="hljs language-ts"/);
  assert.match(firstPage, /&amp;lt;script&amp;gt;|&lt;script&gt;/);
  assert.doesNotMatch(firstPage, /<script>alert/);
  assert.match(firstPage, /data-inkpath-diagram/);
  assert.match(firstPage, /src="\/docs\/_inkpath\/inkpath\.js"/);
  assert.doesNotMatch(secondPage, /inkpath\.js/);
  assert.match(secondPage, /id="repeat"/);
  assert.match(secondPage, /id="repeat-2"/);
  assert.match(secondPage, /The explicit summary wins over the body\./);
  assert.doesNotMatch(secondPage, /aria-label="Breadcrumb"/);
  assert.match(secondPage, /<h2 id="page-toc-title">Contents<\/h2>/);
  assert.doesNotMatch(firstPage, /id="page-toc-title"/);
  assert.match(firstPage, /<li><a href="\/docs\/foundations\/">Foundations<\/a><\/li>/);
  assert.match(secondPage, /aria-label="Adjacent notes"/);
  assert.doesNotMatch(firstPage, /__inkpath\/events/);
  assert.equal(await readFile(path.join(output, "_content", "01-foundations", "sample.txt"), "utf8"), "plain fixture data\n");
  const theme = await readFile(path.join(output, "_inkpath", "theme.css"), "utf8");
  assert.match(theme, /--reading-width: 43\.75rem/);
  assert.match(theme, /--accent: #f36f21/);

  const hashesBefore = await outputHashes(output);
  await buildSite(project);
  assert.deepEqual(await outputHashes(output), hashesBefore);
});

test("keeps generated footnote identifiers separate from heading identifiers", async () => {
  const project = await copyFixture();
  const note = path.join(project, "content", "01-foundations", "01-first.md");
  await writeFile(
    note,
    `${await readFile(note, "utf8")}\n## fn1\n\nA heading that resembles a footnote item.\n\n## fnref1\n\nA heading that resembles a footnote reference.\n`,
  );

  await buildSite(project);
  const html = await readFile(path.join(project, "site", "foundations", "first", "index.html"), "utf8");
  assert.match(html, /<h2 id="fn1"/);
  assert.match(html, /<h2 id="fnref1"/);
  assert.match(html, /id="fn__inkpath-footnote-1"/);
  assert.match(html, /id="fnref__inkpath-footnote-1"/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("keeps a parent link on nested section pages", async () => {
  const project = await copyFixture();
  const nested = path.join(project, "content", "01-foundations", "01-nested");
  await mkdir(nested);
  await writeFile(
    path.join(nested, "README.md"),
    "---\ntitle: Nested section\ndescription: A section inside Foundations.\n---\n\nNested content.\n",
  );

  await buildSite(project);
  const html = await readFile(path.join(project, "site", "foundations", "nested", "index.html"), "utf8");
  assert.match(html, /<li><a href="\/docs\/foundations\/">Foundations<\/a><\/li>/);
});

test("removes footnote syntax from automatic summaries", async (t) => {
  const cases = [
    {
      name: "inline footnote",
      paragraph: "An inline claim.^[See [details](https://example.com/guide) for context.] A second sentence.",
      summary: "An inline claim.",
    },
    {
      name: "named footnote",
      paragraph: "A named claim.[^context] A second sentence.\n\n[^context]: Context that belongs below the note.",
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
      assert.equal(result.site.pageBySource.get("01-foundations/01-first.md")?.summary, fixture.summary);
    });
  }
});

test("fails on missing documents, fragments, and assets", async (t) => {
  await t.test("missing Markdown document", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("02-second.md#second-section", "missing.md"));
    await assert.rejects(buildSite(project, { write: false }), /missing Markdown link target missing\.md/);
  });

  await t.test("missing fragment", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("#second-section", "#missing-section"));
    await assert.rejects(buildSite(project, { write: false }), /missing anchor #missing-section/);
  });

  await t.test("missing asset", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(note, (await readFile(note, "utf8")).replace("sample.txt", "missing.txt"));
    await assert.rejects(buildSite(project, { write: false }), /missing local asset 01-foundations\/missing\.txt/);
  });

  await t.test("hidden asset", async () => {
    const project = await copyFixture();
    const note = path.join(project, "content", "01-foundations", "01-first.md");
    await writeFile(path.join(project, "content", "01-foundations", ".hidden.txt"), "hidden\n");
    await writeFile(note, (await readFile(note, "utf8")).replace("sample.txt", ".hidden.txt"));
    await assert.rejects(buildSite(project, { write: false }), /hidden local assets are not supported/);
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
    await writeFile(note, (await readFile(note, "utf8")).replace("  client[Client]", "  click client \"javascript:alert(1)\"\n  client[Client]"));
    await assert.rejects(buildSite(project, { write: false }), /click directives are not supported/);
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
    await assert.rejects(buildSite(project, { write: false }), /content and output directories cannot overlap/);
  });

  await t.test("public equal to content", async () => {
    const project = await copyFixture();
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: content\noutput: site\npublic: content\n",
    );
    await assert.rejects(buildSite(project, { write: false }), /content and public directories cannot overlap/);
  });

  await t.test("content root symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await rm(path.join(project, "content"), { recursive: true });
    await symlink(external, path.join(project, "content"), "dir");
    await assert.rejects(buildSite(project, { write: false }), /content cannot be or pass through a symbolic link/);
  });

  await t.test("intermediate symbolic link", async () => {
    const project = await copyFixture();
    await mkdir(path.join(project, "real"), { recursive: true });
    await cp(path.join(project, "content"), path.join(project, "real", "notes"), { recursive: true });
    await symlink(path.join(project, "real"), path.join(project, "alias"), "dir");
    await writeFile(
      path.join(project, "inkpath.yaml"),
      "content: alias/notes\noutput: real\npublic: public\n",
    );
    await assert.rejects(buildSite(project, { write: false }), /content cannot be or pass through a symbolic link/);
  });

  await t.test("nested public symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await symlink(external, path.join(project, "public", "escape"), "dir");
    await assert.rejects(buildSite(project, { write: false }), /public cannot contain symbolic links/);
  });

  await t.test("hidden content symbolic link", async () => {
    const project = await copyFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "inkpath-external-"));
    await symlink(external, path.join(project, "content", ".hidden"), "dir");
    await assert.rejects(buildSite(project, { write: false }), /content cannot contain symbolic links/);
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
    await assert.rejects(buildSite(project, { write: false }), /content and output directories cannot overlap/);
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
      assert.match(await readFile(path.join(content, "README.md"), "utf8"), /Fixture notes/);
      const entries = await readdir(project);
      assert.equal(entries.some((entry) => entry.startsWith(".site.inkpath-stage-")), false);
      assert.equal(entries.some((entry) => entry.startsWith(".site.inkpath-previous-")), false);
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
