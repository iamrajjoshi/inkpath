import path from "node:path";
import { parsePageUpdate } from "./content.js";
import type { InkpathConfig, Page, PageKind, Site } from "./types.js";
import { normalizeRoute } from "./utils.js";

export type SourceChange = {
  raw?: string;
  relativePath: string;
  replacedRelativePath?: string;
  sourcePath: string;
};

type SiteSourceState = Pick<
  Page,
  "attributes" | "body" | "order" | "readingMinutes" | "slug" | "summary" | "title"
> & {
  directory: string;
  fileName: string;
  isIndex: boolean;
  relativePath: string;
  sourcePath: string;
};

function sourceState(page: Page): SiteSourceState {
  const fileName = path.posix.basename(page.relativePath);
  return {
    attributes: page.attributes,
    body: page.body,
    directory: page.sourceDirectory,
    fileName,
    isIndex: /^index\.md$/i.test(fileName),
    order: page.order,
    readingMinutes: page.readingMinutes,
    relativePath: page.relativePath,
    slug: page.slug,
    sourcePath: page.sourcePath,
    summary: page.summary,
    title: page.title,
  };
}

function emptyPage(change: SourceChange): Page {
  const directory = path.posix.dirname(change.relativePath);
  const sourceDirectory = directory === "." ? "" : directory;
  const isIndex = /^index\.md$/i.test(path.posix.basename(change.relativePath));
  const kind: PageKind = isIndex ? (sourceDirectory ? "section" : "home") : "page";
  return {
    attributes: {},
    backlinks: [],
    body: "",
    children: [],
    depth: 0,
    headings: [],
    kind,
    order: 0,
    readingMinutes: 0,
    relativePath: change.relativePath,
    rendered: "",
    route: "/",
    slug: "",
    sourceDirectory,
    sourcePath: change.sourcePath,
    summary: "",
    title: "",
  };
}

function changedSourceState(change: SourceChange, existing?: Page): SiteSourceState | undefined {
  if (change.relativePath.split("/").some((segment) => segment.startsWith("."))) return undefined;
  if (change.raw === undefined) return undefined;
  const fileName = path.posix.basename(change.relativePath);
  if (/^readme\.md$/i.test(fileName)) {
    throw new Error(
      `${change.relativePath}: content overview files must be named INDEX.md, not README.md`,
    );
  }
  const update = parsePageUpdate(change.raw, existing ?? emptyPage(change));
  if (update.draft) return undefined;
  const directory = path.posix.dirname(change.relativePath);
  return {
    attributes: update.attributes,
    body: update.body,
    directory: directory === "." ? "" : directory,
    fileName,
    isIndex: /^index\.md$/i.test(fileName),
    order: update.order,
    readingMinutes: update.readingMinutes,
    relativePath: change.relativePath,
    slug: update.slug,
    sourcePath: change.sourcePath,
    summary: update.summary,
    title: update.title,
  };
}

function directoryChain(directory: string): string[] {
  if (!directory) return [];
  const parts = directory.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function routeSegmentsForDirectory(
  directory: string,
  indexByDirectory: ReadonlyMap<string, SiteSourceState>,
): string[] {
  if (!directory) return [];
  const parts = directory.split("/");
  return parts.map((_, index) => {
    const sourceDirectory = parts.slice(0, index + 1).join("/");
    const indexSource = indexByDirectory.get(sourceDirectory);
    if (!indexSource) {
      throw new Error(`${sourceDirectory}: published Markdown directories need an INDEX.md`);
    }
    return indexSource.slug;
  });
}

function comparePages(left: Page, right: Page): number {
  return (
    left.order - right.order ||
    left.title.localeCompare(right.title) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function sortChildren(pages: Page[]): void {
  pages.sort(comparePages);
  for (const page of pages) sortChildren(page.children);
}

/** Match walkMarkdown's sorted depth-first directory traversal. */
function compareSourcePaths(left: SiteSourceState, right: SiteSourceState): number {
  const leftSegments = left.relativePath.split("/");
  const rightSegments = right.relativePath.split("/");
  const length = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const order = (leftSegments[index] as string).localeCompare(rightSegments[index] as string);
    if (order) return order;
  }
  return leftSegments.length - rightSegments.length;
}

function createSite(config: InkpathConfig, sources: readonly SiteSourceState[]): Site {
  if (!sources.length) throw new Error("content directory contains no Markdown files");
  const indexByDirectory = new Map<string, SiteSourceState>();
  for (const source of sources) {
    if (!source.isIndex) continue;
    const existing = indexByDirectory.get(source.directory);
    if (existing) {
      throw new Error(`${source.directory || "content"}: use only one INDEX.md per directory`);
    }
    indexByDirectory.set(source.directory, source);
  }
  if (!indexByDirectory.has("")) throw new Error("content needs a root INDEX.md");
  for (const source of sources) {
    for (const directory of directoryChain(source.directory)) {
      if (!indexByDirectory.has(directory)) {
        throw new Error(`${directory}: published Markdown directories need an INDEX.md`);
      }
    }
  }

  const pages: Page[] = [];
  const pageByRoute = new Map<string, Page>();
  const pageBySource = new Map<string, Page>();
  const sectionByDirectory = new Map<string, Page>();
  for (const source of [...sources].sort(compareSourcePaths)) {
    const isHome = source.isIndex && !source.directory;
    const kind: PageKind = isHome ? "home" : source.isIndex ? "section" : "page";
    const route = isHome
      ? "/"
      : normalizeRoute(
          [
            ...routeSegmentsForDirectory(source.directory, indexByDirectory),
            ...(source.isIndex ? [] : [source.slug]),
          ].join("/"),
        );
    const page: Page = {
      attributes: source.attributes,
      backlinks: [],
      body: source.body,
      children: [],
      depth: route.split("/").filter(Boolean).length,
      headings: [],
      kind,
      order: source.order,
      readingMinutes: source.readingMinutes,
      relativePath: source.relativePath,
      rendered: "",
      route,
      slug: source.slug,
      sourceDirectory: source.directory,
      sourcePath: source.sourcePath,
      summary: source.summary,
      title: source.title,
    };
    const owner = pageByRoute.get(route);
    if (owner) {
      throw new Error(
        `${source.relativePath}: route ${route} is already owned by ${owner.relativePath}`,
      );
    }
    pageByRoute.set(route, page);
    pageBySource.set(source.relativePath, page);
    pages.push(page);
    if (kind === "section") sectionByDirectory.set(source.directory, page);
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
  sortChildren(home.children);

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

/** Rebuild site topology from cached page state and only the changed source bytes. */
export function reconcileSiteSources(
  previous: Site,
  config: InkpathConfig,
  changes: readonly SourceChange[],
): Site {
  const sources = new Map(
    previous.pages.map((page) => [page.relativePath, sourceState(page)] as const),
  );
  for (const change of changes) {
    if (change.replacedRelativePath) sources.delete(change.replacedRelativePath);
    const next = changedSourceState(change, previous.pageBySource.get(change.relativePath));
    if (next) sources.set(change.relativePath, next);
    else sources.delete(change.relativePath);
  }
  return createSite(config, [...sources.values()]);
}
