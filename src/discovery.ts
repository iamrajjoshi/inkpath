import type { Page, Site } from "./types.js";
import { escapeHtml, siteUrl } from "./utils.js";

function absolutePageUrl(site: Site, page: Page): string {
  const base = site.config.site.url;
  if (!base) throw new Error("site.url is required for absolute page URLs");
  return new URL(siteUrl(site.config.site.basePath, page.route), `${base}/`).href;
}

function isoDate(value: unknown): string | undefined {
  if (!(typeof value === "string" || value instanceof Date)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function pageDate(page: Page): string | undefined {
  return isoDate(page.attributes.updated) ?? isoDate(page.attributes.date);
}

function datedPages(site: Site): Array<{ date: string; page: Page }> {
  return site.pages
    .flatMap((page) => {
      const date = pageDate(page);
      return date ? [{ date, page }] : [];
    })
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || left.page.route.localeCompare(right.page.route),
    );
}

export function renderSitemap(site: Site): string | undefined {
  if (!site.config.site.url) return undefined;
  const urls = [...site.pages]
    .sort((left, right) => left.route.localeCompare(right.route))
    .map((page) => {
      const modified = pageDate(page);
      return `  <url>\n    <loc>${escapeHtml(absolutePageUrl(site, page))}</loc>${modified ? `\n    <lastmod>${escapeHtml(modified)}</lastmod>` : ""}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderRss(site: Site): string | undefined {
  if (!site.config.site.url) return undefined;
  const pages = datedPages(site);
  if (!pages.length) return undefined;
  const title = site.config.site.title ?? site.home.title;
  const description = site.config.site.description ?? site.home.summary;
  const home = absolutePageUrl(site, site.home);
  const self = new URL(`${site.config.site.basePath}/rss.xml`, `${site.config.site.url}/`).href;
  const items = pages
    .map(
      ({ date, page }) => `    <item>
      <title>${escapeHtml(page.title)}</title>
      <link>${escapeHtml(absolutePageUrl(site, page))}</link>
      <guid isPermaLink="true">${escapeHtml(absolutePageUrl(site, page))}</guid>
      <pubDate>${new Date(date).toUTCString()}</pubDate>
      <description>${escapeHtml(page.summary)}</description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(title)}</title>
    <link>${escapeHtml(home)}</link>
    <description>${escapeHtml(description)}</description>
    <language>${escapeHtml(site.config.site.lang)}</language>
    <lastBuildDate>${new Date(pages[0]?.date ?? "").toUTCString()}</lastBuildDate>
    <atom:link href="${escapeHtml(self)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

export function renderAtom(site: Site): string | undefined {
  if (!site.config.site.url) return undefined;
  const pages = datedPages(site);
  if (!pages.length) return undefined;
  const title = site.config.site.title ?? site.home.title;
  const home = absolutePageUrl(site, site.home);
  const self = new URL(`${site.config.site.basePath}/atom.xml`, `${site.config.site.url}/`).href;
  const author = site.config.site.author ?? title;
  const entries = pages
    .map(({ date, page }) => {
      const url = absolutePageUrl(site, page);
      const published = isoDate(page.attributes.date);
      return `  <entry>
    <title>${escapeHtml(page.title)}</title>
    <id>${escapeHtml(url)}</id>
    <link href="${escapeHtml(url)}" />
    <updated>${escapeHtml(date)}</updated>${published ? `\n    <published>${escapeHtml(published)}</published>` : ""}
    <summary>${escapeHtml(page.summary)}</summary>
  </entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(title)}</title>
  <id>${escapeHtml(home)}</id>
  <link href="${escapeHtml(home)}" />
  <link href="${escapeHtml(self)}" rel="self" />
  <updated>${escapeHtml(pages[0]?.date ?? "")}</updated>
  <author><name>${escapeHtml(author)}</name></author>
${entries}
</feed>
`;
}

export function orphanPages(site: Site): Page[] {
  return site.pages
    .filter((page) => page.kind === "page" && page.backlinks.length === 0)
    .sort((left, right) => left.route.localeCompare(right.route));
}

export function renderOrphanReport(site: Site): string {
  return `${JSON.stringify(
    orphanPages(site).map((page) => ({
      route: siteUrl(site.config.site.basePath, page.route),
      source: page.relativePath,
      title: page.title,
    })),
    null,
    2,
  )}\n`;
}
