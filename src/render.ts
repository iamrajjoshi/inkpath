import type { Page, Site } from "./types.js";
import { escapeHtml, formatDate, siteUrl } from "./utils.js";
import { INKPATH_VERSION } from "./version.js";

export type DocumentAssets = {
  commitSha?: string;
  diagrams: number;
  math: number;
  mermaidEntry?: string;
};

function pageUrl(site: Site, page: Page): string {
  return siteUrl(site.config.site.basePath, page.route);
}

function publicAssetUrl(site: Site, asset: string): string {
  const encoded = asset.split("/").map(encodeURIComponent).join("/");
  return `${site.config.site.basePath}/${encoded}`;
}

function stylesheetUrl(site: Site): string {
  const stylesheet = site.config.theme.stylesheet;
  return stylesheet
    ? publicAssetUrl(site, stylesheet)
    : `${site.config.site.basePath}/_inkpath/theme.css`;
}

function renderSiteMark(site: Site): string {
  const logo = site.config.site.logo;
  if (logo) {
    return `<img class="site-logo" src="${escapeHtml(publicAssetUrl(site, logo))}" alt="" width="28" height="28">`;
  }
  return `<span class="site-mark" aria-hidden="true"><span></span><span></span><span></span></span>`;
}

function renderBreadcrumb(site: Site, page: Page): string {
  if (page.kind === "home") return "";
  const trail: Page[] = [];
  let item = page.parent;
  while (item) {
    trail.unshift(item);
    item = item.parent;
  }
  const entries = trail
    .map((entry, index) => {
      const label = entry.kind === "home" ? "Home" : entry.title;
      const separator =
        index < trail.length - 1
          ? `<span class="breadcrumbs__separator" aria-hidden="true">/</span>`
          : "";
      return `<li><a href="${escapeHtml(pageUrl(site, entry))}">${escapeHtml(label)}</a>${separator}</li>`;
    })
    .join("");
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${entries}</ol></nav>`;
}

function renderMetadata(site: Site, page: Page): string {
  const values: string[] = [];
  if (site.config.theme.showPageDetails) {
    const identifier =
      typeof page.attributes.identifier === "string" ? page.attributes.identifier : undefined;
    if (identifier) values.push(escapeHtml(identifier));
  }
  const breadcrumb = renderBreadcrumb(site, page);
  if (breadcrumb) values.push(breadcrumb);

  if (site.config.theme.showPageDetails) {
    const updated = formatDate(page.attributes.updated);
    const published = formatDate(page.attributes.date);
    if (updated) values.push(escapeHtml(`Updated ${updated}`));
    else if (published) values.push(escapeHtml(published));
    if (typeof page.attributes.duration === "string") {
      values.push(escapeHtml(page.attributes.duration));
    }
    if (typeof page.attributes.difficulty === "string") {
      values.push(escapeHtml(page.attributes.difficulty));
    }
  }

  if (!values.length) return "";
  return `<ul class="page-meta" aria-label="Page details">${values.map((value) => `<li>${value}</li>`).join("")}</ul>`;
}

function renderTags(site: Site, page: Page): string {
  if (!site.config.theme.showPageDetails) return "";
  const tags = page.attributes.tags;
  if (!tags?.length) return "";
  return `<ul class="page-tags" aria-label="Tags">${tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join("")}</ul>`;
}

function renderHeader(site: Site, page: Page): string {
  return `<header class="page-header">
    <h1>${escapeHtml(page.title)}</h1>
    ${renderMetadata(site, page)}
    ${renderTags(site, page)}
    <p class="lede">${escapeHtml(page.summary)}</p>
  </header>`;
}

function renderToc(page: Page): string {
  if (page.headings.length < 3) return "";
  const entries = page.headings
    .map(
      (heading) =>
        `<li data-depth="${heading.depth}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.title)}</a></li>`,
    )
    .join("");
  return `<nav class="page-toc" aria-labelledby="page-toc-title">
    <h2 id="page-toc-title">Contents</h2>
    <ol>${entries}</ol>
  </nav>`;
}

function contentItemMeta(site: Site, page: Page): string {
  if (!site.config.theme.showListDetails) return "";
  const values: string[] = [];
  if (typeof page.attributes.identifier === "string") values.push(page.attributes.identifier);
  if (typeof page.attributes.duration === "string") values.push(page.attributes.duration);
  if (typeof page.attributes.difficulty === "string") values.push(page.attributes.difficulty);
  return values.length
    ? `<span class="content-list__meta">${escapeHtml(values.join(" · "))}</span>`
    : "";
}

function renderBacklinks(site: Site, page: Page): string {
  if (!page.backlinks.length) return "";
  const links = page.backlinks
    .map(
      (source) =>
        `<li><a href="${escapeHtml(pageUrl(site, source))}">${escapeHtml(source.title)}</a></li>`,
    )
    .join("");
  return `<section class="backlinks" aria-labelledby="backlinks-title">
    <h2 id="backlinks-title">Backlinks</h2>
    <ul>${links}</ul>
  </section>`;
}

function renderContentList(site: Site, page: Page): string {
  const children = page.children.filter(
    (child) => child.kind === "section" || child.kind === "page",
  );
  if (!children.length) return "";
  const label = page.kind === "home" ? "Collections" : "Notes";
  const items = children
    .map(
      (child) => `<li>
        <a href="${escapeHtml(pageUrl(site, child))}">
          <span class="content-list__title"><span class="content-list__title-text">${escapeHtml(child.title)}</span>${contentItemMeta(site, child)}</span>
          <span class="content-list__summary">${escapeHtml(child.summary)}</span>
        </a>
      </li>`,
    )
    .join("");
  return `<section aria-labelledby="content-list-title">
    <h2 id="content-list-title" class="section-heading">${label}</h2>
    <ol class="content-list">${items}</ol>
  </section>`;
}

function renderPagination(site: Site, page: Page): string {
  if (page.kind !== "page" || !page.parent) return "";
  const siblings = page.parent.children.filter((child) => child.kind === "page");
  const index = siblings.indexOf(page);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;
  if (!previous && !next) return "";
  return `<nav class="page-pagination" aria-label="Adjacent notes">
    ${previous ? `<a rel="prev" href="${escapeHtml(pageUrl(site, previous))}"><span>Previous</span><strong>${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}
    ${next ? `<a rel="next" href="${escapeHtml(pageUrl(site, next))}"><span>Next</span><strong>${escapeHtml(next.title)}</strong></a>` : ""}
  </nav>`;
}

function renderFooter(site: Site, page: Page): string {
  const pagination = renderPagination(site, page);
  if (!pagination) return "";
  return `<footer class="page-footer">
    ${pagination}
  </footer>`;
}

function renderBuildCommit(page: Page, commitSha?: string): string {
  if (page.kind !== "home" || !commitSha) return "";
  const shortSha = commitSha.slice(0, 7);
  return `<footer class="build-commit">Commit <code>${escapeHtml(shortSha)}</code></footer>`;
}

function absoluteCanonical(site: Site, page: Page): string | undefined {
  const base = site.config.site.url;
  if (!base) return undefined;
  return new URL(pageUrl(site, page), base.endsWith("/") ? base : `${base}/`).href;
}

function absolutePublicAsset(site: Site, asset: string): string | undefined {
  const base = site.config.site.url;
  if (!base) return undefined;
  return new URL(publicAssetUrl(site, asset), `${base}/`).href;
}

function hasFeeds(site: Site): boolean {
  return site.pages.some(
    (page) =>
      formatDate(page.attributes.updated) !== undefined ||
      formatDate(page.attributes.date) !== undefined,
  );
}

function renderSocialMetadata(site: Site, page: Page, title: string, canonical?: string): string {
  if (!canonical) return "";
  const imageAsset = site.config.site.image ?? site.config.site.logo;
  const image = imageAsset ? absolutePublicAsset(site, imageAsset) : undefined;
  const siteTitle = site.config.site.title ?? site.home.title;
  const tags = page.attributes.tags ?? [];
  return [
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.summary)}">`,
    `<meta property="og:type" content="${page.kind === "page" ? "article" : "website"}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    `<meta property="og:site_name" content="${escapeHtml(siteTitle)}">`,
    ...(image
      ? [
          `<meta property="og:image" content="${escapeHtml(image)}">`,
          `<meta property="og:image:alt" content="${escapeHtml(siteTitle)}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
        ]
      : []),
    ...(page.kind === "page" && page.attributes.date
      ? [
          `<meta property="article:published_time" content="${escapeHtml(new Date(page.attributes.date).toISOString())}">`,
        ]
      : []),
    ...(page.kind === "page" && page.attributes.updated
      ? [
          `<meta property="article:modified_time" content="${escapeHtml(new Date(page.attributes.updated).toISOString())}">`,
        ]
      : []),
    ...(page.kind === "page"
      ? tags.map((tag) => `<meta property="article:tag" content="${escapeHtml(tag)}">`)
      : []),
  ].join("\n  ");
}

export function renderDocument(site: Site, page: Page, assets: DocumentAssets): string {
  const siteTitle = site.config.site.title ?? site.home.title;
  const description = page.summary;
  const title = page.kind === "home" ? siteTitle : `${page.title} · ${siteTitle}`;
  const canonical = absoluteCanonical(site, page);
  const bodyContent = `<article class="prose">${page.rendered}</article>`;
  const buildCommit = renderBuildCommit(page, assets.commitSha);
  const listing = renderContentList(site, page);
  const script =
    assets.diagrams && assets.mermaidEntry
      ? `<script type="module" src="${escapeHtml(`${site.config.site.basePath}/_inkpath/${assets.mermaidEntry}`)}"></script>`
      : "";
  const feeds = hasFeeds(site);

  return `<!doctype html>
<html lang="${escapeHtml(site.config.site.lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="generator" content="Inkpath ${escapeHtml(INKPATH_VERSION)}">
  ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  ${renderSocialMetadata(site, page, title, canonical)}
  ${feeds ? `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteTitle)} RSS" href="${escapeHtml(`${site.config.site.basePath}/rss.xml`)}">` : ""}
  ${feeds ? `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(siteTitle)} Atom" href="${escapeHtml(`${site.config.site.basePath}/atom.xml`)}">` : ""}
  <link rel="icon" href="${escapeHtml(`${site.config.site.basePath}/favicon.svg`)}" type="image/svg+xml">
  <link rel="stylesheet" href="${escapeHtml(stylesheetUrl(site))}">
  ${assets.math ? `<link rel="stylesheet" href="${escapeHtml(`${site.config.site.basePath}/_inkpath/katex/katex.min.css`)}">` : ""}
</head>
<body${buildCommit ? ` class="has-build-commit"` : ""}>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <div class="site-header__inner">
      <a class="site-brand" href="${escapeHtml(pageUrl(site, site.home))}">
        ${renderSiteMark(site)}
        <span class="site-title">${escapeHtml(siteTitle)}</span>
      </a>
    </div>
  </header>
  <main class="page-shell" id="main-content">
    ${renderHeader(site, page)}
    ${renderToc(page)}
    ${bodyContent}
    ${listing}
    ${renderBacklinks(site, page)}
    ${renderFooter(site, page)}
  </main>
  ${buildCommit}
  ${script}
</body>
</html>
`;
}

export function renderNotFound(site: Site): string {
  const siteTitle = site.config.site.title ?? site.home.title;
  return `<!doctype html><html lang="${escapeHtml(site.config.site.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · ${escapeHtml(siteTitle)}</title><link rel="stylesheet" href="${escapeHtml(stylesheetUrl(site))}"></head><body><main class="page-shell"><header class="page-header"><h1>Page not found</h1><p class="lede">The requested note does not exist.</p></header><p><a href="${escapeHtml(pageUrl(site, site.home))}">Return to the contents</a></p></main></body></html>\n`;
}
