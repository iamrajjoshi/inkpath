import path from "node:path";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import type { Page, Site } from "./types.js";
import { escapeHtml, isExternalUrl, siteUrl, slugify, toPosix } from "./utils.js";

type RenderEnvironment = {
  anchors: Set<string>;
  assets: Set<string>;
  headings: Page["headings"];
  internalReferences: Array<{ fragment?: string; target: Page }>;
  page: Page;
  site: Site;
  diagramCount: number;
};

function contentAssetUrl(site: Site, sourceRelativePath: string): string {
  const encoded = sourceRelativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${site.config.site.basePath}/_content/${encoded}`;
}

function splitReference(reference: string): { pathPart: string; suffix: string } {
  const match = reference.match(/^([^?#]*)(.*)$/);
  return { pathPart: match?.[1] ?? reference, suffix: match?.[2] ?? "" };
}

function rewriteReference(reference: string, environment: RenderEnvironment): string {
  if (!reference || reference.startsWith("/")) return reference;
  if (reference.startsWith("#")) {
    const fragment = reference.slice(1);
    environment.internalReferences.push({ fragment, target: environment.page });
    return reference;
  }
  if (isExternalUrl(reference)) return reference;

  const { pathPart, suffix } = splitReference(reference);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    throw new Error(`${environment.page.relativePath}: malformed URL ${reference}`);
  }
  const resolved = toPosix(path.posix.normalize(path.posix.join(environment.page.sourceDirectory, decodedPath)));
  if (resolved.startsWith("../") || resolved === "..") {
    throw new Error(`${environment.page.relativePath}: link leaves the content directory: ${reference}`);
  }

  if (/\.md$/i.test(decodedPath)) {
    const target = environment.site.pageBySource.get(resolved);
    if (!target) throw new Error(`${environment.page.relativePath}: missing Markdown link target ${reference}`);
    const fragment = suffix.match(/#([^#]+)$/)?.[1];
    environment.internalReferences.push(fragment ? { fragment, target } : { target });
    return `${siteUrl(environment.site.config.site.basePath, target.route)}${suffix}`;
  }

  if (resolved.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error(`${environment.page.relativePath}: hidden local assets are not supported: ${reference}`);
  }
  environment.assets.add(resolved);
  return `${contentAssetUrl(environment.site, resolved)}${suffix}`;
}

function validateMermaid(source: string, page: Page): void {
  if (source.length > 40_000) {
    throw new Error(`${page.relativePath}: Mermaid diagram exceeds the 40,000 character limit`);
  }
  if (!/^\s*accTitle\s*:/m.test(source) || !/^\s*accDescr\s*(?::|\{)/m.test(source)) {
    throw new Error(`${page.relativePath}: Mermaid diagrams need accTitle and accDescr for accessibility`);
  }
  if (/^\s*click\s+/m.test(source)) {
    throw new Error(`${page.relativePath}: Mermaid click directives are not supported`);
  }
}

function createMarkdown(environment: RenderEnvironment): MarkdownIt {
  const markdown = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  }).use(footnote);

  markdown.core.ruler.push("inkpath-heading-ids", (state) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (!token || token.type !== "heading_open") continue;
      const depth = Number(token.tag.slice(1));
      const title = state.tokens[index + 1]?.content.trim() ?? "";
      const base = slugify(title);
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      token.attrSet("id", id);
      token.attrSet("tabindex", "-1");
      environment.anchors.add(id);
      if (depth === 2 || depth === 3) environment.headings.push({ depth, id, title });
    }
  });

  const defaultFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (language === "mermaid") {
      validateMermaid(token.content, environment.page);
      environment.diagramCount += 1;
      return `<pre class="mermaid" data-inkpath-diagram>${escapeHtml(token.content.trim())}</pre>\n`;
    }

    if (!language) {
      return `<pre class="code-block"><code>${escapeHtml(token.content)}</code></pre>\n`;
    }
    const safeLanguage = escapeHtml(language);
    if (!hljs.getLanguage(language)) {
      return `<pre class="code-block"><code class="language-${safeLanguage}">${escapeHtml(token.content)}</code></pre>\n`;
    }
    const highlighted = hljs.highlight(token.content, { language, ignoreIllegals: true }).value;
    return `<pre class="code-block"><code class="hljs language-${safeLanguage}">${highlighted}</code></pre>\n`;
  };

  const defaultLinkOpen = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const href = token?.attrGet("href");
    if (token && href) token.attrSet("href", rewriteReference(href, environment));
    return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };

  const defaultImage = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const source = token?.attrGet("src");
    if (token && source) {
      token.attrSet("src", rewriteReference(source, environment));
      token.attrSet("loading", "lazy");
      token.attrSet("decoding", "async");
    }
    return defaultImage ? defaultImage(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
  };

  if (defaultFence) void defaultFence;
  return markdown;
}

export function renderMarkdown(page: Page, site: Site): {
  anchors: Set<string>;
  assets: Set<string>;
  diagrams: number;
  html: string;
  internalReferences: Array<{ fragment?: string; target: Page }>;
} {
  page.headings = [];
  const environment: RenderEnvironment = {
    anchors: new Set<string>(),
    assets: new Set<string>(),
    headings: page.headings,
    internalReferences: [],
    page,
    site,
    diagramCount: 0,
  };
  const markdown = createMarkdown(environment);
  const html = markdown.render(page.body, environment);
  return {
    anchors: environment.anchors,
    assets: environment.assets,
    diagrams: environment.diagramCount,
    html,
    internalReferences: environment.internalReferences,
  };
}
