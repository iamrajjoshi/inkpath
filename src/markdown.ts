import path from "node:path";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import type { Page, Site } from "./types.js";
import { escapeHtml, isExternalUrl, siteUrl, slugify, toPosix } from "./utils.js";

type RenderEnvironment = {
  annotationCount: number;
  anchors: Set<string>;
  assets: Set<string>;
  headings: Page["headings"];
  internalReferences: Array<{ fragment?: string; target: Page }>;
  page: Page;
  site: Site;
  diagramCount: number;
};

const annotationLabels = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
} as const;

type AnnotationKind = keyof typeof annotationLabels;

function installAnnotations(markdown: MarkdownIt, environment: RenderEnvironment): void {
  markdown.core.ruler.before("inline", "inkpath-annotations", (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const opening = state.tokens[index];
      const paragraphOpening = state.tokens[index + 1];
      const content = state.tokens[index + 2];
      const paragraphClosing = state.tokens[index + 3];
      if (
        opening?.type !== "blockquote_open" ||
        paragraphOpening?.type !== "paragraph_open" ||
        content?.type !== "inline" ||
        paragraphClosing?.type !== "paragraph_close"
      ) {
        continue;
      }

      const marker = content.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/);
      if (!marker) continue;

      let depth = 0;
      let closingIndex = -1;
      for (let candidate = index; candidate < state.tokens.length; candidate += 1) {
        const token = state.tokens[candidate];
        if (token?.type === "blockquote_open") depth += 1;
        if (token?.type === "blockquote_close") {
          depth -= 1;
          if (depth === 0) {
            closingIndex = candidate;
            break;
          }
        }
      }
      if (closingIndex < 0) continue;

      const kind = marker[1] as AnnotationKind;
      const label = annotationLabels[kind];
      const labelId = `__inkpath-annotation-${environment.annotationCount + 1}-label`;
      environment.annotationCount += 1;

      opening.tag = "aside";
      opening.attrSet("class", `annotation annotation--${kind.toLowerCase()}`);
      opening.attrSet("role", "note");
      opening.attrSet("aria-labelledby", labelId);
      const closing = state.tokens[closingIndex];
      if (closing) closing.tag = "aside";

      const labelOpening = new state.Token("paragraph_open", "p", 1);
      labelOpening.block = true;
      labelOpening.level = paragraphOpening.level;
      labelOpening.attrSet("class", "annotation__label");
      labelOpening.attrSet("id", labelId);
      const labelContent = new state.Token("inline", "", 0);
      labelContent.block = true;
      labelContent.level = content.level;
      labelContent.content = label;
      labelContent.children = [];
      const labelClosing = new state.Token("paragraph_close", "p", -1);
      labelClosing.block = true;
      labelClosing.level = paragraphClosing.level;
      const labelTokens = [labelOpening, labelContent, labelClosing];

      content.content = content.content.slice(marker[0].length);
      if (content.content.trim()) {
        state.tokens.splice(index + 1, 0, ...labelTokens);
      } else {
        state.tokens.splice(index + 1, 3, ...labelTokens);
      }
    }
  });
}

function footnoteLabelId(environment: RenderEnvironment): string {
  const id = "__inkpath-footnotes-label";
  environment.anchors.add(id);
  return id;
}

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

  installAnnotations(markdown, environment);

  markdown.renderer.rules.footnote_block_open = () => {
    const labelId = footnoteLabelId(environment);
    return `<section class="footnotes" aria-labelledby="${labelId}">\n<h2 class="visually-hidden" id="${labelId}">Footnotes</h2>\n<ol class="footnotes-list">\n`;
  };

  markdown.renderer.rules.footnote_anchor_name = (tokens, index) => {
    const number = Number(tokens[index]?.meta?.id ?? 0) + 1;
    return `__inkpath-footnote-${number}`;
  };

  markdown.renderer.rules.footnote_ref = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    const id = renderer.rules.footnote_anchor_name?.(tokens, index, options, env, renderer) ?? "";
    const caption = renderer.rules.footnote_caption?.(tokens, index, options, env, renderer) ?? "";
    const subId = Number(token.meta?.subId ?? 0);
    const referenceId = subId > 0 ? `${id}:${subId}` : id;
    const number = Number(token.meta?.id ?? 0) + 1;
    const occurrence = subId > 0 ? `, occurrence ${subId + 1}` : "";
    return `<sup class="footnote-ref"><a href="#fn${id}" id="fnref${referenceId}" aria-label="Footnote ${number}${occurrence}">${caption}</a></sup>`;
  };

  markdown.renderer.rules.footnote_anchor = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    if (!token) return "";
    let id = renderer.rules.footnote_anchor_name?.(tokens, index, options, env, renderer) ?? "";
    const subId = Number(token.meta?.subId ?? 0);
    if (subId > 0) id += `:${subId}`;
    const number = Number(token.meta?.id ?? 0) + 1;
    const occurrence = subId > 0 ? `, occurrence ${subId + 1}` : "";
    return ` <a href="#fnref${id}" class="footnote-backref" aria-label="Back to footnote reference ${number}${occurrence}">\u21a9\uFE0E</a>`;
  };

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
    annotationCount: 0,
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
