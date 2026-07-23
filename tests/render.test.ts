import assert from "node:assert/strict";
import test from "node:test";
import { createSiteRenderer, renderDocument } from "../src/render.js";
import type { Page, Site } from "../src/types.js";

const assets = { diagrams: 0, math: 0 };

function createPage(kind: Page["kind"], title: string, route: string): Page {
  return {
    attributes: {},
    backlinks: [],
    body: "",
    children: [],
    depth: 0,
    headings: [],
    kind,
    order: 0,
    readingMinutes: 1,
    relativePath: `${title}.md`,
    rendered: `<p>${title} content.</p>`,
    route,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    sourceDirectory: "",
    sourcePath: `/content/${title}.md`,
    summary: `${title} summary.`,
    title,
  };
}

function createSite(pages: Page[], home: Page, url?: string): Site {
  return {
    config: {
      contentDir: "/project/content",
      markdown: { math: false },
      outputDir: "/project/site",
      projectRoot: "/project",
      publicDir: "/project/public",
      site: {
        basePath: "/docs",
        lang: "en",
        title: "Render test",
        ...(url ? { url } : {}),
      },
      theme: {
        accent: "#111111",
        interactive: "#222222",
        interactiveHover: "#333333",
        showListDetails: false,
        showPageDetails: false,
        subtle: "#444444",
      },
    },
    home,
    pageByRoute: new Map(pages.map((page) => [page.route, page])),
    pageBySource: new Map(pages.map((page) => [page.relativePath, page])),
    pages,
    sections: pages.filter((page) => page.kind === "section"),
  };
}

test("indexes site and sibling metadata once while preserving pagination order", () => {
  const home = createPage("home", "Home", "/");
  const section = createPage("section", "Section", "/section/");
  const first = createPage("page", "First", "/section/first/");
  const nestedSection = createPage("section", "Nested", "/section/nested/");
  const middle = createPage("page", "Middle", "/section/middle/");
  const last = createPage("page", "Last", "/section/last/");

  section.parent = home;
  for (const child of [first, nestedSection, middle, last]) child.parent = section;
  home.children = [section];

  const siblings = [first, nestedSection, middle, last];
  let siblingReads = 0;
  Object.defineProperty(section, "children", {
    configurable: true,
    get() {
      siblingReads += 1;
      return siblings;
    },
  });

  // Deliberately differs from the local child order: pagination is defined by
  // parent.children, while the site index should still visit site.pages once.
  const pages = [last, home, middle, nestedSection, section, first];
  const site = createSite(pages, home, "https://example.test");
  let pageReads = 0;
  site.pages = new Proxy(pages, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) pageReads += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const renderer = createSiteRenderer(site);
  const firstHtml = renderer.document(first, assets);
  const middleHtml = renderer.document(middle, assets);
  const lastHtml = renderer.document(last, assets);
  assert.equal(renderer.document(middle, assets), middleHtml);

  assert.equal(pageReads, pages.length);
  assert.equal(siblingReads, 1);
  assert.match(firstHtml, /rel="next" href="\/docs\/section\/middle\/"/);
  assert.doesNotMatch(firstHtml, /\/docs\/section\/nested\//);
  assert.match(middleHtml, /rel="prev" href="\/docs\/section\/first\/"/);
  assert.match(middleHtml, /rel="next" href="\/docs\/section\/last\/"/);
  assert.match(lastHtml, /rel="prev" href="\/docs\/section\/middle\/"/);
});

test("only advertises feeds when discovery files can be generated", () => {
  const home = createPage("home", "Home", "/");
  const dated = createPage("page", "Dated", "/dated/");
  dated.attributes.date = "2026-01-02";
  dated.parent = home;
  home.children = [dated];
  const pages = [home, dated];

  const privateHtml = renderDocument(createSite(pages, home), dated, assets);
  assert.doesNotMatch(privateHtml, /rel="alternate"/);

  const publicHtml = renderDocument(createSite(pages, home, "https://example.test"), dated, assets);
  assert.match(publicHtml, /rel="alternate" type="application\/rss\+xml"/);
  assert.match(publicHtml, /rel="alternate" type="application\/atom\+xml"/);
});

test("compatibility rendering cannot retain stale site metadata", () => {
  const home = createPage("home", "Home", "/");
  const first = createPage("page", "First", "/first/");
  const second = createPage("page", "Second", "/second/");
  first.attributes.date = "2026-01-02";
  first.parent = home;
  second.parent = home;
  home.children = [first, second];
  const site = createSite([home, first, second], home, "https://example.test");

  const initial = renderDocument(site, first, assets);
  assert.match(initial, /Render test/);
  assert.match(initial, /rel="alternate"/);
  assert.match(initial, /rel="next" href="\/docs\/second\/"/);

  site.config.site.title = "Changed title";
  delete first.attributes.date;
  home.children = [second, first];
  const changed = renderDocument(site, first, assets);
  assert.match(changed, /Changed title/);
  assert.doesNotMatch(changed, /rel="alternate"/);
  assert.match(changed, /rel="prev" href="\/docs\/second\/"/);
  assert.doesNotMatch(changed, /rel="next"/);
});
