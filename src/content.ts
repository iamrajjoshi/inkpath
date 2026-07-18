import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { Frontmatter, Page, InkpathConfig, Site } from "./types.js";
import {
  firstSentence,
  normalizeRoute,
  orderFromName,
  slugify,
  stripOrderPrefix,
  titleFromSlug,
  toPosix,
} from "./utils.js";

type SourceDocument = {
  attributes: Frontmatter;
  body: string;
  directory: string;
  fileName: string;
  isIndex: boolean;
  relativePath: string;
  sourcePath: string;
};

async function walkMarkdown(directory: string, root = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `content cannot contain symbolic links: ${toPosix(path.relative(root, entryPath))}`,
      );
    }
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      paths.push(...(await walkMarkdown(entryPath, root)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      paths.push(path.relative(root, entryPath));
    }
  }

  return paths;
}

function parseFrontmatter(
  raw: string,
  relativePath: string,
): { attributes: Frontmatter; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { attributes: {}, body: raw.trim() };
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${relativePath}: frontmatter is missing its closing ---`);
  const parsed: unknown = YAML.parse(match[1] ?? "");
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`${relativePath}: frontmatter must be a YAML mapping`);
  }

  const attributes = (parsed ?? {}) as Frontmatter;
  for (const key of ["title", "description", "summary", "slug"] as const) {
    const value = attributes[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${relativePath}: ${key} must be a non-empty string`);
    }
  }
  if (
    attributes.order !== undefined &&
    (!Number.isInteger(attributes.order) || attributes.order < 0)
  ) {
    throw new Error(`${relativePath}: order must be a non-negative integer`);
  }
  if (
    attributes.tags !== undefined &&
    (!Array.isArray(attributes.tags) || attributes.tags.some((tag) => typeof tag !== "string"))
  ) {
    throw new Error(`${relativePath}: tags must be a list of strings`);
  }
  if (attributes.draft !== undefined && typeof attributes.draft !== "boolean") {
    throw new Error(`${relativePath}: draft must be true or false`);
  }

  return {
    attributes,
    body: raw.slice(match[0].length).trim(),
  };
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function codeSpanEnd(value: string, index: number): number | undefined {
  if (value[index] !== "`" || isEscaped(value, index)) return undefined;
  let delimiterEnd = index;
  while (value[delimiterEnd] === "`") delimiterEnd += 1;
  const delimiter = value.slice(index, delimiterEnd);
  const closing = value.indexOf(delimiter, delimiterEnd);
  return closing >= 0 ? closing + delimiter.length : undefined;
}

function stripInlineFootnotes(markdown: string): string {
  let result = "";
  let index = 0;
  while (index < markdown.length) {
    const spanEnd = codeSpanEnd(markdown, index);
    if (spanEnd !== undefined) {
      result += markdown.slice(index, spanEnd);
      index = spanEnd;
      continue;
    }
    if (markdown[index] === "^" && markdown[index + 1] === "[" && !isEscaped(markdown, index)) {
      let cursor = index + 2;
      let depth = 1;
      while (cursor < markdown.length && depth > 0) {
        if (markdown[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (markdown[cursor] === "[") depth += 1;
        else if (markdown[cursor] === "]") depth -= 1;
        cursor += 1;
      }
      if (depth === 0) {
        index = cursor;
        continue;
      }
    }
    result += markdown[index];
    index += 1;
  }
  return result;
}

function footnoteDefinitionLabels(markdown: string): Set<string> {
  const labels = new Set<string>();
  for (const match of markdown.matchAll(/^[ \t]{0,3}\[\^([^\]\s]+)\]:/gm)) {
    if (match[1]) labels.add(match[1]);
  }
  return labels;
}

function stripNamedFootnoteReferences(markdown: string, labels: Set<string>): string {
  if (!labels.size) return markdown;
  let result = "";
  let index = 0;
  while (index < markdown.length) {
    const spanEnd = codeSpanEnd(markdown, index);
    if (spanEnd !== undefined) {
      result += markdown.slice(index, spanEnd);
      index = spanEnd;
      continue;
    }
    if (markdown[index] === "[" && markdown[index + 1] === "^" && !isEscaped(markdown, index)) {
      const closing = markdown.indexOf("]", index + 2);
      if (closing > index + 2 && labels.has(markdown.slice(index + 2, closing))) {
        index = closing + 1;
        if (markdown[index] === ":") index += 1;
        continue;
      }
    }
    result += markdown[index];
    index += 1;
  }
  return result;
}

function plainText(markdown: string, footnoteLabels = new Set<string>()): string {
  return stripNamedFootnoteReferences(stripInlineFootnotes(markdown), footnoteLabels)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  return match ? plainText(match[1] ?? "") : undefined;
}

function stripLeadingTitle(body: string): string {
  return body.replace(/^\s*#\s+.+?\s*#*\s*(?:\r?\n)+/, "").trim();
}

function deriveSummary(body: string): string {
  const lines = body.split(/\r?\n/);
  let paragraph: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (!paragraph.length && /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\||<)/.test(trimmed)) continue;
    paragraph.push(trimmed);
  }

  return firstSentence(plainText(paragraph.join(" "), footnoteDefinitionLabels(body)));
}

function readingMinutes(body: string): number {
  const withoutFences = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
  const words = plainText(withoutFences, footnoteDefinitionLabels(body))
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function validSlug(value: string, relativePath: string): string {
  const slug = slugify(value);
  if (!slug || slug.includes("/")) throw new Error(`${relativePath}: invalid slug`);
  return slug;
}

function routeSegmentsForDirectory(
  directory: string,
  indexByDirectory: Map<string, SourceDocument>,
): string[] {
  if (!directory) return [];
  const parts = directory.split("/");
  const segments: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const sourceDirectory = parts.slice(0, index + 1).join("/");
    const indexDocument = indexByDirectory.get(sourceDirectory);
    const requestedSlug = indexDocument?.attributes.slug;
    segments.push(
      validSlug(
        requestedSlug ?? stripOrderPrefix(parts[index] ?? ""),
        indexDocument?.relativePath ?? sourceDirectory,
      ),
    );
  }

  return segments;
}

function sortPages(pages: Page[]): void {
  pages.sort(
    (left, right) =>
      left.order - right.order ||
      left.title.localeCompare(right.title) ||
      left.relativePath.localeCompare(right.relativePath),
  );
  for (const page of pages) sortPages(page.children);
}

function directoryChain(directory: string): string[] {
  if (!directory) return [];
  const parts = directory.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function navigationPages(site: Site): Page[] {
  const ordered: Page[] = [];
  const visit = (page: Page) => {
    if (page.kind === "page") ordered.push(page);
    for (const child of page.children) visit(child);
  };
  visit(site.home);
  return ordered;
}

export async function loadSite(config: InkpathConfig): Promise<Site> {
  let relativePaths: string[];
  try {
    relativePaths = await walkMarkdown(config.contentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`content directory does not exist: ${config.contentDir}`);
    }
    throw error;
  }
  if (!relativePaths.length) throw new Error("content directory contains no Markdown files");

  const documents: SourceDocument[] = [];
  for (const relativeFilePath of relativePaths) {
    const sourcePath = path.join(config.contentDir, relativeFilePath);
    const relativePath = toPosix(relativeFilePath);
    const fileName = path.posix.basename(relativePath);
    if (/^readme\.md$/i.test(fileName)) {
      throw new Error(
        `${relativePath}: content overview files must be named INDEX.md, not README.md`,
      );
    }
    const parsed = parseFrontmatter(await readFile(sourcePath, "utf8"), relativePath);
    if (parsed.attributes.draft) continue;
    documents.push({
      ...parsed,
      directory: path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath),
      fileName,
      isIndex: /^index\.md$/i.test(fileName),
      relativePath,
      sourcePath,
    });
  }

  const indexByDirectory = new Map<string, SourceDocument>();
  for (const document of documents.filter((item) => item.isIndex)) {
    const existing = indexByDirectory.get(document.directory);
    if (existing) {
      throw new Error(`${document.directory || "content"}: use only one INDEX.md per directory`);
    }
    indexByDirectory.set(document.directory, document);
  }
  const rootDocument = indexByDirectory.get("");
  if (!rootDocument) throw new Error("content needs a root INDEX.md");
  for (const document of documents) {
    for (const directory of directoryChain(document.directory)) {
      if (!indexByDirectory.has(directory)) {
        throw new Error(`${directory}: published Markdown directories need an INDEX.md`);
      }
    }
  }

  const pages: Page[] = [];
  const pageByRoute = new Map<string, Page>();
  const pageBySource = new Map<string, Page>();
  const sectionByDirectory = new Map<string, Page>();

  for (const document of documents) {
    const stem = document.fileName.replace(/\.md$/i, "");
    const directorySegments = routeSegmentsForDirectory(document.directory, indexByDirectory);
    const isHome = document.isIndex && !document.directory;
    const kind = isHome ? "home" : document.isIndex ? "section" : "page";
    const slug = document.isIndex
      ? (directorySegments.at(-1) ?? "")
      : validSlug(document.attributes.slug ?? stripOrderPrefix(stem), document.relativePath);
    const route = isHome
      ? "/"
      : normalizeRoute([...directorySegments, ...(document.isIndex ? [] : [slug])].join("/"));
    const title =
      document.attributes.title?.trim() ||
      firstHeading(document.body) ||
      titleFromSlug(slug || "home");
    const body = stripLeadingTitle(document.body);
    const summary =
      document.attributes.summary?.trim() ||
      document.attributes.description?.trim() ||
      deriveSummary(body) ||
      title;
    const order =
      document.attributes.order ??
      orderFromName(document.isIndex ? (document.directory.split("/").at(-1) ?? "") : stem);
    const page: Page = {
      attributes: document.attributes,
      body,
      children: [],
      depth: route.split("/").filter(Boolean).length,
      headings: [],
      kind,
      order,
      readingMinutes: readingMinutes(body),
      relativePath: document.relativePath,
      rendered: "",
      route,
      slug,
      sourceDirectory: document.directory,
      sourcePath: document.sourcePath,
      summary,
      title,
    };

    if (pageByRoute.has(route)) {
      throw new Error(
        `${document.relativePath}: route ${route} is already owned by ${pageByRoute.get(route)?.relativePath}`,
      );
    }
    pageByRoute.set(route, page);
    pageBySource.set(document.relativePath, page);
    pages.push(page);
    if (kind === "section") sectionByDirectory.set(document.directory, page);
  }

  const home = pages.find((page) => page.kind === "home");
  if (!home) throw new Error("could not create the home page");

  for (const page of pages) {
    if (page === home) continue;
    let parentDirectory =
      page.kind === "page" ? page.sourceDirectory : path.posix.dirname(page.sourceDirectory);
    if (parentDirectory === ".") parentDirectory = "";
    let parent = sectionByDirectory.get(parentDirectory);
    while (!parent && parentDirectory) {
      parentDirectory = path.posix.dirname(parentDirectory);
      if (parentDirectory === ".") parentDirectory = "";
      parent = sectionByDirectory.get(parentDirectory);
    }
    page.parent = parent ?? home;
    page.parent.children.push(page);
  }
  sortPages(home.children);

  config.site.title ??= home.title;
  config.site.description ??= home.summary;

  return {
    config,
    home,
    pages,
    pageByRoute,
    pageBySource,
    sections: home.children.filter((page) => page.kind === "section"),
  };
}
