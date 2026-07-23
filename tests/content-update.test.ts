import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { loadSite, parsePageUpdate } from "../src/content.js";
import type { Page, Site } from "../src/types.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "site");

async function fixtureSite(): Promise<Site> {
  return loadSite(await loadConfig(fixtureRoot));
}

function fixturePage(site: Site): Page {
  const page = site.pageBySource.get("01-foundations/01-first.md");
  assert.ok(page);
  return page;
}

async function sourceFor(page: Page): Promise<string> {
  return readFile(page.sourcePath, "utf8");
}

test("parsePageUpdate exactly matches loadSite derivation for every published page", async () => {
  const site = await fixtureSite();

  for (const page of site.pages) {
    const update = parsePageUpdate(await sourceFor(page), page);
    assert.deepEqual(
      {
        attributes: update.attributes,
        body: update.body,
        order: update.order,
        readingMinutes: update.readingMinutes,
        slug: update.slug,
        summary: update.summary,
        title: update.title,
      },
      {
        attributes: page.attributes,
        body: page.body,
        order: page.order,
        readingMinutes: page.readingMinutes,
        slug: page.slug,
        summary: page.summary,
        title: page.title,
      },
      page.relativePath,
    );
    assert.equal(update.draft, false, page.relativePath);
    assert.deepEqual(
      update.changes,
      {
        attributes: false,
        body: false,
        draft: false,
        order: false,
        readingMinutes: false,
        slug: false,
        summary: false,
        title: false,
      },
      page.relativePath,
    );
    assert.equal(update.requiresStructuralRebuild, false, page.relativePath);
  }
});

test("parsePageUpdate derives and strips a first-heading title without mutating the page", async () => {
  const page = fixturePage(await fixtureSite());
  const original = {
    attributes: { ...page.attributes, tags: [...(page.attributes.tags ?? [])] },
    body: page.body,
    order: page.order,
    readingMinutes: page.readingMinutes,
    slug: page.slug,
    summary: page.summary,
    title: page.title,
  };
  const attributesReference = page.attributes;

  const update = parsePageUpdate(
    `---
date: 2026-02-03
tags:
  - parsing
  - updates
---

# A *derived* title

The first **sentence** becomes the summary. Another sentence follows.
`,
    page,
  );

  assert.equal(update.title, "A derived title");
  assert.equal(
    update.body,
    "The first **sentence** becomes the summary. Another sentence follows.",
  );
  assert.equal(update.summary, "The first sentence becomes the summary.");
  assert.equal(update.readingMinutes, 1);
  assert.equal(update.slug, "first");
  assert.equal(update.order, 1);
  assert.deepEqual(update.attributes.tags, ["parsing", "updates"]);
  assert.equal(update.attributes.date, "2026-02-03");
  assert.equal(update.changes.attributes, true);
  assert.equal(update.changes.title, true);
  assert.equal(update.changes.slug, false);
  assert.equal(update.changes.order, false);
  assert.equal(update.requiresStructuralRebuild, true);

  assert.equal(page.attributes, attributesReference);
  assert.deepEqual(
    {
      attributes: page.attributes,
      body: page.body,
      order: page.order,
      readingMinutes: page.readingMinutes,
      slug: page.slug,
      summary: page.summary,
      title: page.title,
    },
    original,
  );
});

test("parsePageUpdate honors explicit frontmatter and reports structural differences", async () => {
  const page = fixturePage(await fixtureSite());
  const update = parsePageUpdate(
    `---
title: "  Replacement title  "
description: Description fallback.
summary: "  Explicit summary.  "
slug: New Route
order: 8
identifier: R8
duration: 12 minutes
difficulty: Advanced
tags: [alpha, beta]
date: 2026-03-04
updated: 2026-03-05T12:00:00Z
---

# Body heading is still stripped

Body summary should not win.
`,
    page,
  );

  assert.equal(update.title, "Replacement title");
  assert.equal(update.summary, "Explicit summary.");
  assert.equal(update.body, "Body summary should not win.");
  assert.equal(update.slug, "new-route");
  assert.equal(update.order, 8);
  assert.deepEqual(update.attributes.tags, ["alpha", "beta"]);
  assert.equal(update.attributes.date, "2026-03-04");
  assert.equal(update.attributes.updated, "2026-03-05T12:00:00Z");
  assert.equal(update.changes.attributes, true);
  assert.equal(update.changes.title, true);
  assert.equal(update.changes.slug, true);
  assert.equal(update.changes.order, true);
  assert.equal(update.requiresStructuralRebuild, true);
});

test("parsePageUpdate compares date values semantically and tag arrays in order", async () => {
  const page = fixturePage(await fixtureSite());
  const raw = await sourceFor(page);
  const dateObjectPage: Page = {
    ...page,
    attributes: { ...page.attributes, date: new Date("2026-01-02T00:00:00.000Z") },
  };
  const equivalentDate = parsePageUpdate(
    raw.replace("date: 2026-01-02", "date: 2026-01-01T16:00:00-08:00"),
    dateObjectPage,
  );
  assert.equal(equivalentDate.changes.attributes, false);
  assert.equal(equivalentDate.requiresStructuralRebuild, false);

  const reversedTags = parsePageUpdate(
    raw.replace("  - reliability\n  - storage", "  - storage\n  - reliability"),
    page,
  );
  assert.equal(reversedTags.changes.attributes, true);
  assert.equal(reversedTags.changes.title, false);
  assert.equal(reversedTags.changes.slug, false);
  assert.equal(reversedTags.changes.order, false);
  assert.equal(reversedTags.requiresStructuralRebuild, false);

  const changedDate = parsePageUpdate(raw.replace("date: 2026-01-02", "date: 2026-01-03"), page);
  assert.equal(changedDate.changes.attributes, true);
  assert.equal(changedDate.changes.title, false);
  assert.equal(changedDate.requiresStructuralRebuild, false);
});

test("parsePageUpdate surfaces a transition from published to draft", async () => {
  const page = fixturePage(await fixtureSite());
  const raw = await sourceFor(page);
  const update = parsePageUpdate(raw.replace("---\n", "---\ndraft: true\n"), page);

  assert.equal(update.draft, true);
  assert.equal(update.changes.draft, true);
  assert.equal(update.changes.attributes, true);
  assert.equal(update.requiresStructuralRebuild, true);
  assert.equal(page.attributes.draft, undefined);
});

test("parsePageUpdate applies the same frontmatter validation as loadSite", async (t) => {
  const page = fixturePage(await fixtureSite());
  const cases = [
    {
      name: "unknown key",
      raw: "---\ndescripton: Typo\n---\n\nBody.\n",
      expected: /unknown frontmatter key "descripton".*Did you mean "description"/,
    },
    {
      name: "obsolete number key",
      raw: "---\nnumber: A1\n---\n\nBody.\n",
      expected: /unknown frontmatter key "number".*use "identifier".*"order"/s,
    },
    {
      name: "non-mapping frontmatter",
      raw: "---\n- first\n- second\n---\n\nBody.\n",
      expected: /frontmatter must be a YAML mapping/,
    },
    {
      name: "missing closing marker",
      raw: "---\ntitle: Missing close\n\nBody.\n",
      expected: /frontmatter is missing its closing ---/,
    },
    {
      name: "empty title",
      raw: '---\ntitle: "  "\n---\n\nBody.\n',
      expected: /title must be a non-empty string/,
    },
    {
      name: "invalid order",
      raw: "---\norder: -1\n---\n\nBody.\n",
      expected: /order must be a non-negative integer/,
    },
    {
      name: "invalid tags",
      raw: "---\ntags: alpha\n---\n\nBody.\n",
      expected: /tags must be a list of strings/,
    },
    {
      name: "invalid date",
      raw: "---\ndate: definitely-not-a-date\n---\n\nBody.\n",
      expected: /date must be a valid date/,
    },
    {
      name: "invalid draft flag",
      raw: '---\ndraft: "sometimes"\n---\n\nBody.\n',
      expected: /draft must be true or false/,
    },
  ];

  for (const example of cases) {
    await t.test(example.name, () => {
      assert.throws(() => parsePageUpdate(example.raw, page), example.expected);
    });
  }
});
