import type { Page, Site } from "./types.js";
import { escapeHtml, formatDate, siteUrl } from "./utils.js";

function pageUrl(site: Site, page: Page): string {
  return siteUrl(site.config.site.basePath, page.route);
}

function publicAssetUrl(site: Site, asset: string): string {
  const encoded = asset.split("/").map(encodeURIComponent).join("/");
  return `${site.config.site.basePath}/${encoded}`;
}

function renderSiteMark(site: Site): string {
  const logo = site.config.site.logo;
  if (logo) {
    return `<img class="site-logo" src="${escapeHtml(publicAssetUrl(site, logo))}" alt="" width="28" height="28">`;
  }
  return `<span class="site-mark" aria-hidden="true"><span></span><span></span><span></span></span>`;
}

function renderMetadata(site: Site, page: Page): string {
  const values: string[] = [];
  const number = typeof page.attributes.number === "string" ? page.attributes.number : undefined;
  if (number) values.push(escapeHtml(number));
  if (page.kind === "section") {
    if (page.parent?.kind === "section") {
      values.push(`<a href="${escapeHtml(pageUrl(site, page.parent))}">${escapeHtml(page.parent.title)}</a>`);
    }
  } else if (page.kind === "page" && page.parent?.kind === "section") {
    values.push(`<a href="${escapeHtml(pageUrl(site, page.parent))}">${escapeHtml(page.parent.title)}</a>`);
  }

  const updated = formatDate(page.attributes.updated);
  const published = formatDate(page.attributes.date);
  if (updated) values.push(escapeHtml(`Updated ${updated}`));
  else if (published) values.push(escapeHtml(published));

  if (!values.length) return "";
  return `<ul class="page-meta" aria-label="Page details">${values.map((value) => `<li>${value}</li>`).join("")}</ul>`;
}

function renderHeader(site: Site, page: Page): string {
  return `<header class="page-header">
    <h1>${escapeHtml(page.title)}</h1>
    ${renderMetadata(site, page)}
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

function contentItemMeta(page: Page): string {
  const values: string[] = [];
  if (typeof page.attributes.number === "string") values.push(page.attributes.number);
  return values.length ? `<span class="content-list__meta">${escapeHtml(values.join(" · "))}</span>` : "";
}

function renderContentList(site: Site, page: Page): string {
  const children = page.children.filter((child) => child.kind === "section" || child.kind === "page");
  if (!children.length) return "";
  const label = page.kind === "home" ? "Collections" : "Notes";
  const items = children
    .map(
      (child) => `<li>
        <a href="${escapeHtml(pageUrl(site, child))}">
          <span class="content-list__title"><span class="content-list__title-text">${escapeHtml(child.title)}</span>${contentItemMeta(child)}</span>
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

function absoluteCanonical(site: Site, page: Page): string | undefined {
  const base = site.config.site.url;
  if (!base) return undefined;
  return new URL(pageUrl(site, page), base.endsWith("/") ? base : `${base}/`).href;
}

export function renderDocument(site: Site, page: Page, diagrams: number): string {
  const siteTitle = site.config.site.title ?? site.home.title;
  const description = page.summary;
  const title = page.kind === "home" ? siteTitle : `${page.title} · ${siteTitle}`;
  const canonical = absoluteCanonical(site, page);
  const bodyContent = `<article class="prose">${page.rendered}</article>`;
  const listing = renderContentList(site, page);
  const script = diagrams
    ? `<script type="module" src="${escapeHtml(`${site.config.site.basePath}/_inkpath/inkpath.js`)}"></script>`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(site.config.site.lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="generator" content="Inkpath 0.1.0">
  ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}
  <link rel="icon" href="${escapeHtml(`${site.config.site.basePath}/favicon.svg`)}" type="image/svg+xml">
  <link rel="stylesheet" href="${escapeHtml(`${site.config.site.basePath}/_inkpath/theme.css`)}">
</head>
<body>
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
    ${renderFooter(site, page)}
  </main>
  ${script}
</body>
</html>
`;
}

export function renderNotFound(site: Site): string {
  const siteTitle = site.config.site.title ?? site.home.title;
  return `<!doctype html><html lang="${escapeHtml(site.config.site.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · ${escapeHtml(siteTitle)}</title><link rel="stylesheet" href="${escapeHtml(`${site.config.site.basePath}/_inkpath/theme.css`)}"></head><body><main class="page-shell"><header class="page-header"><h1>Page not found</h1><p class="lede">The requested note does not exist.</p></header><p><a href="${escapeHtml(pageUrl(site, site.home))}">Return to the contents</a></p></main></body></html>\n`;
}
