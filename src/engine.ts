import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { buildSite, buildSnapshot, type BuildOptions, type BuildSnapshot } from "./build.js";
import { mapConcurrentOrdered } from "./concurrency.js";
import { parsePageUpdate } from "./content.js";
import {
  orphanPages,
  renderAtom,
  renderOrphanReport,
  renderRss,
  renderSitemap,
} from "./discovery.js";
import {
  createMarkdownRenderer,
  type MarkdownRenderer,
  type MarkdownRenderResult,
} from "./markdown.js";
import { replaceOutputFiles, type OutputFileChange } from "./output-transaction.js";
import { createSiteRenderer, type SiteRenderer } from "./render.js";
import { reconcileSiteSources, type SourceChange } from "./site-reconciliation.js";
import type {
  BuildResult,
  BuildTimings,
  Frontmatter,
  IncrementalBuildStats,
  InkpathConfig,
  Page,
  PageNeighbors,
  Site,
} from "./types.js";
import { isPathWithin, toPosix } from "./utils.js";

export type BuildEngine = {
  build(options?: BuildOptions): Promise<BuildResult>;
  check(options?: BuildOptions): Promise<BuildResult>;
  close(): Promise<void>;
  rebuild(changedPaths: readonly string[], options?: BuildOptions): Promise<BuildResult>;
};

type IncomingReferences = Map<Page, Map<Page, Array<string | undefined>>>;

type EngineState = {
  generatedOutputHashes: Map<string, string> | undefined;
  incoming: IncomingReferences;
  navigationOrder: Map<Page, number>;
  result: BuildResult;
  siteRenderer: SiteRenderer;
  snapshot: BuildSnapshot;
};

type GeneratedOutput = {
  contents: string;
  hash: string;
};

type PageFields = Pick<
  Page,
  | "attributes"
  | "body"
  | "headings"
  | "order"
  | "readingMinutes"
  | "rendered"
  | "slug"
  | "summary"
  | "title"
>;

type FileSystemError = Error & { code: string };

function isFileSystemError(error: unknown, ...codes: readonly string[]): error is FileSystemError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function incrementalStats(
  mode: IncrementalBuildStats["mode"],
  changedPaths: number,
  values: Partial<Omit<IncrementalBuildStats, "changedPaths" | "mode">> = {},
): IncrementalBuildStats {
  return {
    changedPaths,
    mode,
    parsedPages: values.parsedPages ?? 0,
    renderedDocuments: values.renderedDocuments ?? 0,
    renderedMarkdown: values.renderedMarkdown ?? 0,
    writtenFiles: values.writtenFiles ?? 0,
  };
}

function emptyTimings(totalMs: number): BuildTimings {
  return {
    assetsMs: 0,
    configMs: 0,
    contentMs: 0,
    documentRenderMs: 0,
    graphMs: 0,
    markdownMs: 0,
    outputWriteMs: 0,
    publishMs: 0,
    totalMs,
  };
}

function withoutTimings(result: BuildResult): Omit<BuildResult, "timings"> {
  const { timings: _timings, ...rest } = result;
  return rest;
}

function routeOutputPath(route: string): string {
  if (route === "/") return "index.html";
  return `${route.replace(/^\/+|\/+$/g, "")}/index.html`;
}

function currentTarget(site: Site, target: Page): Page {
  return site.pageBySource.get(target.relativePath) ?? target;
}

function referencedTargets(site: Site, source: Page, render: MarkdownRenderResult): Set<Page> {
  const targets = new Set<Page>();
  for (const reference of render.internalReferences) {
    const target = currentTarget(site, reference.target);
    if (target !== source) targets.add(target);
  }
  return targets;
}

function normalizeRender(site: Site, render: MarkdownRenderResult): MarkdownRenderResult {
  return {
    ...render,
    internalReferences: render.internalReferences.map((reference) => {
      const target = currentTarget(site, reference.target);
      return reference.fragment === undefined
        ? { target }
        : { fragment: reference.fragment, target };
    }),
  };
}

function createIncoming(renders: Map<Page, MarkdownRenderResult>): IncomingReferences {
  const incoming: IncomingReferences = new Map();
  for (const [source, render] of renders) {
    for (const reference of render.internalReferences) {
      if (reference.target === source) continue;
      let sources = incoming.get(reference.target);
      if (!sources) {
        sources = new Map();
        incoming.set(reference.target, sources);
      }
      let fragments = sources.get(source);
      if (!fragments) {
        fragments = [];
        sources.set(source, fragments);
      }
      fragments.push(reference.fragment);
    }
  }
  return incoming;
}

function replaceIncomingSource(
  incoming: IncomingReferences,
  source: Page,
  previous: MarkdownRenderResult,
  next: MarkdownRenderResult,
): void {
  for (const reference of previous.internalReferences) {
    if (reference.target === source) continue;
    const sources = incoming.get(reference.target);
    sources?.delete(source);
    if (!sources?.size) incoming.delete(reference.target);
  }
  for (const reference of next.internalReferences) {
    if (reference.target === source) continue;
    let sources = incoming.get(reference.target);
    if (!sources) {
      sources = new Map();
      incoming.set(reference.target, sources);
    }
    let fragments = sources.get(source);
    if (!fragments) {
      fragments = [];
      sources.set(source, fragments);
    }
    fragments.push(reference.fragment);
  }
}

function assertFragment(
  source: Page,
  target: Page,
  fragment: string,
  anchors: ReadonlySet<string>,
): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    throw new Error(`${source.relativePath}: malformed anchor #${fragment}`);
  }
  if (!anchors.has(decoded)) {
    throw new Error(`${source.relativePath}: missing anchor #${decoded} in ${target.relativePath}`);
  }
}

function validateCandidateAnchors(
  state: EngineState,
  page: Page,
  candidate: MarkdownRenderResult,
): void {
  for (const reference of candidate.internalReferences) {
    if (!reference.fragment) continue;
    const target = currentTarget(state.result.site, reference.target);
    const anchors =
      target === page ? candidate.anchors : state.snapshot.renders.get(target)?.anchors;
    if (!anchors) throw new Error(`missing render state for ${target.relativePath}`);
    assertFragment(page, target, reference.fragment, anchors);
  }

  for (const [source, fragments] of state.incoming.get(page) ?? []) {
    if (source === page) continue;
    for (const fragment of fragments) {
      if (fragment) assertFragment(source, page, fragment, candidate.anchors);
    }
  }
}

async function validateCandidateAssets(
  site: Site,
  page: Page,
  render: MarkdownRenderResult,
): Promise<Map<string, Uint8Array>> {
  const entries = await mapConcurrentOrdered([...new Set(render.assets)], async (asset) => {
    return [asset, await readCandidateAsset(site, page, asset)] as const;
  });
  return new Map(entries);
}

async function readCandidateAsset(site: Site, page: Page, asset: string): Promise<Uint8Array> {
  const absolutePath = path.resolve(site.config.contentDir, asset);
  if (!isPathWithin(site.config.contentDir, absolutePath)) {
    throw new Error(`${page.relativePath}: missing local asset ${asset}`);
  }
  let current = site.config.contentDir;
  const segments = asset.split("/");
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index] as string);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT", "ENOTDIR")) {
        throw new Error(`${page.relativePath}: missing local asset ${asset}`);
      }
      throw error;
    }
    if (
      info.isSymbolicLink() ||
      (index < segments.length - 1 && !info.isDirectory()) ||
      (index === segments.length - 1 && !info.isFile())
    ) {
      throw new Error(`${page.relativePath}: local asset must be a regular file: ${asset}`);
    }
  }
  return readFile(absolutePath);
}

async function outputAssetMatches(
  outputRoot: string,
  asset: string,
  contents: Uint8Array,
): Promise<boolean> {
  let current = outputRoot;
  const segments = ["_content", ...asset.split("/")];
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index < segments.length - 1 && !info.isDirectory()) ||
        (index === segments.length - 1 && !info.isFile())
      ) {
        return false;
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT", "ENOTDIR")) return false;
      throw error;
    }
  }
  return Buffer.from(await readFile(current)).equals(Buffer.from(contents));
}

async function hasPublishedOutput(outputRoot: string): Promise<boolean> {
  const required = [
    { directory: true, target: outputRoot },
    { directory: false, target: path.join(outputRoot, "index.html") },
    { directory: false, target: path.join(outputRoot, "404.html") },
    { directory: true, target: path.join(outputRoot, "_inkpath") },
    { directory: false, target: path.join(outputRoot, "_inkpath", "orphans.json") },
  ];
  for (const item of required) {
    try {
      const info = await lstat(item.target);
      if (info.isSymbolicLink() || (item.directory ? !info.isDirectory() : !info.isFile())) {
        return false;
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT", "ENOTDIR")) return false;
      throw error;
    }
  }
  return true;
}

async function readChangedMarkdown(
  contentRoot: string,
  absolutePath: string,
  relativePath: string,
): Promise<string> {
  let current = contentRoot;
  const segments = relativePath.split("/");
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index] as string);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      const visiblePath = index < 0 ? relativePath : segments.slice(0, index + 1).join("/");
      throw new Error(`content cannot contain symbolic links: ${visiblePath}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`content path is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`content source must be a regular file: ${relativePath}`);
    }
  }
  return readFile(absolutePath, "utf8");
}

async function readPublicOutput(
  publicRoot: string,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  let current = publicRoot;
  const segments = relativePath.split("/");
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index] as string);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT", "ENOTDIR")) return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`public cannot contain symbolic links: ${current}`);
    }
    if (index < segments.length - 1) {
      if (!info.isDirectory()) return undefined;
    } else if (!info.isFile()) {
      return undefined;
    }
  }
  return readFile(current);
}

function previousPageFields(page: Page): PageFields {
  return {
    attributes: page.attributes,
    body: page.body,
    headings: page.headings,
    order: page.order,
    readingMinutes: page.readingMinutes,
    rendered: page.rendered,
    slug: page.slug,
    summary: page.summary,
    title: page.title,
  };
}

function setPageFields(page: Page, fields: PageFields): void {
  page.attributes = fields.attributes;
  page.body = fields.body;
  page.headings = fields.headings;
  page.order = fields.order;
  page.readingMinutes = fields.readingMinutes;
  page.rendered = fields.rendered;
  page.slug = fields.slug;
  page.summary = fields.summary;
  page.title = fields.title;
}

function hasDate(page: Page): boolean {
  return page.attributes.updated !== undefined || page.attributes.date !== undefined;
}

function frontmatterValueEquals(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.valueOf() === right.valueOf();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function changedFrontmatterKeys(left: Frontmatter, right: Frontmatter): Set<string> {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return new Set(
    [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].filter(
      (key) => !frontmatterValueEquals(leftRecord[key], rightRecord[key]),
    ),
  );
}

function supportsIncrementalMetadataUpdate(
  page: Page,
  update: ReturnType<typeof parsePageUpdate>,
): boolean {
  const changedKeys = changedFrontmatterKeys(page.attributes, update.attributes);
  if (!changedKeys.size) return false;
  if ([...changedKeys].some((key) => key !== "title" && key !== "order")) return false;
  if (update.changes.draft || update.changes.slug) return false;
  if (update.changes.title && !changedKeys.has("title")) return false;
  if (update.changes.order && !changedKeys.has("order")) return false;
  return true;
}

function compareSiblings(left: Page, right: Page): number {
  return (
    left.order - right.order ||
    left.title.localeCompare(right.title) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function paginationDependents(page: Page, children: readonly Page[]): Set<Page> {
  const pages = children.filter((child) => child.kind === "page");
  const index = pages.indexOf(page);
  if (index < 0) return new Set([page]);
  return new Set(
    [pages[index - 1], page, pages[index + 1]].filter(
      (candidate): candidate is Page => candidate !== undefined,
    ),
  );
}

function createNavigationOrder(site: Site): Map<Page, number> {
  return new Map(site.pages.map((page, index) => [page, index]));
}

function normalizedChangedPaths(projectRoot: string, changedPaths: readonly string[]): string[] {
  return [
    ...new Set(
      changedPaths.map((changedPath) =>
        path.resolve(projectRoot, changedPath.split(/[\\/]/).join(path.sep)),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

type CaseAliasLookup = (relativePath: string) => readonly Page[];

function createCaseAliasLookup(site: Site): CaseAliasLookup {
  let aliasesByFoldedPath: Map<string, Page[]> | undefined;
  return (relativePath) => {
    if (!aliasesByFoldedPath) {
      aliasesByFoldedPath = new Map();
      for (const page of site.pages) {
        const foldedPath = page.relativePath.toLowerCase();
        const aliases = aliasesByFoldedPath.get(foldedPath) ?? [];
        aliases.push(page);
        aliasesByFoldedPath.set(foldedPath, aliases);
      }
    }
    return aliasesByFoldedPath.get(relativePath.toLowerCase()) ?? [];
  };
}

async function previousCaseAlias(
  candidates: readonly Page[],
  actualRelativePath: string,
  actualSourcePath: string,
): Promise<string | undefined> {
  for (const page of candidates) {
    if (page.relativePath === actualRelativePath) continue;
    try {
      if ((await realpath(page.sourcePath)) === actualSourcePath) return page.relativePath;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
  return undefined;
}

async function readReconciliationChange(
  site: Site,
  config: InkpathConfig,
  changedPath: string,
  caseAliases = createCaseAliasLookup(site),
): Promise<SourceChange> {
  const relativePath = toPosix(path.relative(config.contentDir, changedPath));
  let raw: string | undefined;
  let actualRelativePath = relativePath;
  let replacedRelativePath: string | undefined;
  try {
    const [contents, actualSourcePath] = await Promise.all([
      readChangedMarkdown(config.contentDir, changedPath, relativePath),
      realpath(changedPath),
    ]);
    raw = contents;
    actualRelativePath = toPosix(path.relative(config.contentDir, actualSourcePath));
    replacedRelativePath =
      actualRelativePath !== relativePath
        ? relativePath
        : site.pageBySource.has(actualRelativePath)
          ? undefined
          : await previousCaseAlias(
              caseAliases(actualRelativePath),
              actualRelativePath,
              actualSourcePath,
            );
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  return {
    ...(raw === undefined ? {} : { raw }),
    relativePath: actualRelativePath,
    ...(replacedRelativePath === undefined ? {} : { replacedRelativePath }),
    sourcePath: path.join(config.contentDir, actualRelativePath),
  };
}

function reconciliationConfig(state: EngineState): InkpathConfig {
  const previous = state.result.site.config;
  const site = { ...previous.site };
  if (!state.snapshot.hasConfiguredSiteTitle) delete site.title;
  if (!state.snapshot.hasConfiguredSiteDescription) delete site.description;
  return { ...previous, site };
}

function outputHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function addGeneratedOutput(
  outputs: Map<string, GeneratedOutput>,
  relativePath: string,
  contents: string | undefined,
): void {
  if (contents === undefined) return;
  outputs.set(relativePath, { contents, hash: outputHash(contents) });
}

function renderSharedOutputs(site: Site, siteRenderer: SiteRenderer): Map<string, GeneratedOutput> {
  const outputs = new Map<string, GeneratedOutput>();
  addGeneratedOutput(outputs, "404.html", siteRenderer.notFound());
  addGeneratedOutput(outputs, "_inkpath/orphans.json", renderOrphanReport(site));
  addGeneratedOutput(outputs, "sitemap.xml", renderSitemap(site));
  addGeneratedOutput(outputs, "rss.xml", renderRss(site));
  addGeneratedOutput(outputs, "atom.xml", renderAtom(site));
  return outputs;
}

function sameHeadings(left: Page, right: Page): boolean {
  return (
    left.headings.length === right.headings.length &&
    left.headings.every((heading, index) => {
      const other = right.headings[index];
      return (
        other !== undefined &&
        heading.depth === other.depth &&
        heading.id === other.id &&
        heading.title === other.title
      );
    })
  );
}

function sameDisplayPage(left: Page | undefined, right: Page | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.kind === right.kind &&
      left.route === right.route &&
      left.summary === right.summary &&
      left.title === right.title &&
      frontmatterValueEquals(left.attributes.identifier, right.attributes.identifier) &&
      frontmatterValueEquals(left.attributes.duration, right.attributes.duration) &&
      frontmatterValueEquals(left.attributes.difficulty, right.attributes.difficulty))
  );
}

function sameDisplayPages(left: readonly Page[], right: readonly Page[]): boolean {
  return (
    left.length === right.length && left.every((page, index) => sameDisplayPage(page, right[index]))
  );
}

function parentTrail(page: Page): Page[] {
  const trail: Page[] = [];
  let current = page.parent;
  while (current) {
    trail.unshift(current);
    current = current.parent;
  }
  return trail;
}

function createPageNeighborIndex(site: Site): Map<Page, PageNeighbors> {
  const neighbors = new Map<Page, PageNeighbors>();
  for (const parent of site.pages) {
    const siblings = parent.children.filter((child) => child.kind === "page");
    for (let index = 0; index < siblings.length; index += 1) {
      const page = siblings[index];
      if (!page) continue;
      const previous = siblings[index - 1];
      const next = siblings[index + 1];
      neighbors.set(page, {
        ...(next ? { next } : {}),
        ...(previous ? { previous } : {}),
      });
    }
  }
  return neighbors;
}

function hasFeedLinks(site: Site): boolean {
  return Boolean(site.config.site.url) && site.pages.some(hasDate);
}

function sameDocumentGlobals(left: Site, right: Site): boolean {
  return (
    left.config.site.lang === right.config.site.lang &&
    left.config.site.basePath === right.config.site.basePath &&
    left.config.site.url === right.config.site.url &&
    (left.config.site.title ?? left.home.title) === (right.config.site.title ?? right.home.title) &&
    left.config.site.logo === right.config.site.logo &&
    left.config.site.image === right.config.site.image &&
    left.config.theme.stylesheet === right.config.theme.stylesheet &&
    left.config.theme.showListDetails === right.config.theme.showListDetails &&
    left.config.theme.showPageDetails === right.config.theme.showPageDetails &&
    hasFeedLinks(left) === hasFeedLinks(right)
  );
}

function sameDocumentDependencies(
  previous: Page,
  page: Page,
  previousRender: MarkdownRenderResult,
  render: MarkdownRenderResult,
  previousNeighbors: ReadonlyMap<Page, PageNeighbors>,
  neighbors: ReadonlyMap<Page, PageNeighbors>,
  documentGlobalsEqual: boolean,
): boolean {
  if (!documentGlobalsEqual) return false;
  if (
    previous.kind !== page.kind ||
    previous.route !== page.route ||
    previous.title !== page.title ||
    previous.summary !== page.summary ||
    previous.rendered !== page.rendered ||
    previousRender.diagrams !== render.diagrams ||
    previousRender.math !== render.math ||
    !sameHeadings(previous, page)
  ) {
    return false;
  }
  for (const key of ["identifier", "duration", "difficulty", "tags", "date", "updated"] as const) {
    if (!frontmatterValueEquals(previous.attributes[key], page.attributes[key])) return false;
  }
  if (!sameDisplayPages(previous.children, page.children)) return false;
  if (!sameDisplayPages(previous.backlinks, page.backlinks)) return false;
  if (!sameDisplayPages(parentTrail(previous), parentTrail(page))) return false;
  const previousPageNeighbors = previousNeighbors.get(previous);
  const pageNeighbors = neighbors.get(page);
  return (
    sameDisplayPage(previousPageNeighbors?.previous, pageNeighbors?.previous) &&
    sameDisplayPage(previousPageNeighbors?.next, pageNeighbors?.next)
  );
}

function translatedRender(
  previous: MarkdownRenderResult,
  site: Site,
): MarkdownRenderResult | undefined {
  const internalReferences: MarkdownRenderResult["internalReferences"] = [];
  for (const reference of previous.internalReferences) {
    const target = site.pageBySource.get(reference.target.relativePath);
    if (!target) return undefined;
    internalReferences.push(
      reference.fragment === undefined ? { target } : { fragment: reference.fragment, target },
    );
  }
  return { ...previous, internalReferences };
}

function validateReconciledAnchors(renders: ReadonlyMap<Page, MarkdownRenderResult>): void {
  for (const [source, render] of renders) {
    for (const reference of render.internalReferences) {
      if (!reference.fragment) continue;
      const target = reference.target;
      const targetRender = renders.get(target);
      if (!targetRender) throw new Error(`missing render state for ${target.relativePath}`);
      assertFragment(source, target, reference.fragment, targetRender.anchors);
    }
  }
}

type ReconciledRenderState = {
  assets: Map<string, Uint8Array>;
  assetsMs: number;
  diagrams: number;
  graphMs: number;
  incoming: IncomingReferences;
  markdownMs: number;
  math: number;
  navigationOrder: Map<Page, number>;
  renders: Map<Page, MarkdownRenderResult>;
  renderedMarkdown: number;
};

async function renderReconciledSite(
  state: EngineState,
  site: Site,
  changedSources: ReadonlySet<string>,
  markdownRenderer: MarkdownRenderer,
): Promise<ReconciledRenderState> {
  const rerender = new Set<string>();
  for (const page of site.pages) {
    const previous = state.result.site.pageBySource.get(page.relativePath);
    if (!previous || previous.body !== page.body || previous.route !== page.route) {
      rerender.add(page.relativePath);
    }
  }
  for (const source of changedSources) {
    const previous = state.result.site.pageBySource.get(source);
    const next = site.pageBySource.get(source);
    if (next && (!previous || previous.body !== next.body || previous.route !== next.route)) {
      rerender.add(source);
    }
  }
  for (const previous of state.result.site.pages) {
    const next = site.pageBySource.get(previous.relativePath);
    if (next && next.route === previous.route) continue;
    for (const source of state.incoming.get(previous)?.keys() ?? []) {
      if (site.pageBySource.has(source.relativePath)) rerender.add(source.relativePath);
    }
  }

  const renders = new Map<Page, MarkdownRenderResult>();
  const renderedPages: Array<[Page, MarkdownRenderResult]> = [];
  let markdownMs = 0;
  for (const page of site.pages) {
    const previousPage = state.result.site.pageBySource.get(page.relativePath);
    const previousRender = previousPage ? state.snapshot.renders.get(previousPage) : undefined;
    let render =
      previousRender && !rerender.has(page.relativePath)
        ? translatedRender(previousRender, site)
        : undefined;
    if (render) {
      page.headings = previousPage?.headings.map((heading) => ({ ...heading })) ?? [];
    } else {
      const markdownStarted = performance.now();
      render = markdownRenderer(page, site);
      markdownMs += performance.now() - markdownStarted;
      renderedPages.push([page, render]);
    }
    page.rendered = render.html;
    renders.set(page, render);
  }
  const graphStarted = performance.now();
  validateReconciledAnchors(renders);
  const anchorValidationMs = performance.now() - graphStarted;
  const assets = new Map<string, Uint8Array>();
  const assetsStarted = performance.now();
  const assetOwners = new Map<string, Page>();
  for (const [page, render] of renderedPages) {
    if (!changedSources.has(page.relativePath)) continue;
    for (const asset of render.assets) if (!assetOwners.has(asset)) assetOwners.set(asset, page);
  }
  const assetEntries = await mapConcurrentOrdered([...assetOwners], async ([asset, page]) => {
    return [asset, await readCandidateAsset(site, page, asset)] as const;
  });
  for (const [asset, contents] of assetEntries) {
    assets.set(asset, contents);
  }
  const assetsMs = performance.now() - assetsStarted;

  const backlinkStarted = performance.now();
  const navigationOrder = createNavigationOrder(site);
  const backlinks = new Map(site.pages.map((page) => [page, new Set<Page>()]));
  for (const [source, render] of renders) {
    for (const reference of render.internalReferences) {
      if (reference.target !== source) backlinks.get(reference.target)?.add(source);
    }
  }
  for (const page of site.pages) {
    page.backlinks = [...(backlinks.get(page) ?? [])].sort(
      (left, right) => (navigationOrder.get(left) ?? 0) - (navigationOrder.get(right) ?? 0),
    );
  }

  let diagrams = 0;
  let math = 0;
  for (const render of renders.values()) {
    diagrams += render.diagrams;
    math += render.math;
  }
  const incoming = createIncoming(renders);
  const graphMs = anchorValidationMs + performance.now() - backlinkStarted;
  return {
    assets,
    assetsMs,
    diagrams,
    graphMs,
    incoming,
    markdownMs,
    math,
    navigationOrder,
    renderedMarkdown: renderedPages.length,
    renders,
  };
}

class PersistentBuildEngine implements BuildEngine {
  readonly #markdownRenderer: MarkdownRenderer = createMarkdownRenderer();
  readonly #projectDirectory: string;
  #closed = false;
  #state: EngineState | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(projectDirectory: string) {
    this.#projectDirectory = path.resolve(projectDirectory);
  }

  build(options: BuildOptions = {}): Promise<BuildResult> {
    return this.#schedule(() => this.#fullBuild(options, "clean", 0, performance.now()));
  }

  check(options: BuildOptions = {}): Promise<BuildResult> {
    return this.#schedule(() =>
      this.#fullBuild({ ...options, write: false }, "clean", 0, performance.now()),
    );
  }

  rebuild(changedPaths: readonly string[], options: BuildOptions = {}): Promise<BuildResult> {
    return this.#schedule(() => this.#rebuild(changedPaths, options));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    this.#state = undefined;
  }

  #schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Inkpath build engine is closed"));
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #fullBuild(
    options: BuildOptions,
    mode: "clean" | "full",
    changedPaths: number,
    started: number,
  ): Promise<BuildResult> {
    const built = await buildSite(this.#projectDirectory, options);
    const snapshot = buildSnapshot(built.site);
    if (!snapshot) throw new Error("Inkpath did not retain its compiled page state");
    const stateStarted = performance.now();
    const incoming = createIncoming(snapshot.renders);
    const navigationOrder = createNavigationOrder(built.site);
    const siteRenderer = createSiteRenderer(built.site);
    const stateMs = performance.now() - stateStarted;
    const elapsedMs = performance.now() - started;
    const statistics = incrementalStats(mode, changedPaths, {
      parsedPages: built.pages,
      renderedDocuments: options.write === false ? 0 : built.pages + 1,
      renderedMarkdown: built.pages,
      writtenFiles: options.write === false ? 0 : built.pages + 2,
    });
    const result: BuildResult = {
      ...withoutTimings(built),
      elapsedMs,
      incremental: statistics,
      ...(options.profile && built.timings
        ? {
            timings: {
              ...built.timings,
              graphMs: built.timings.graphMs + stateMs,
              totalMs: elapsedMs,
            },
          }
        : {}),
    };
    this.#state = {
      generatedOutputHashes: undefined,
      incoming,
      navigationOrder,
      result,
      siteRenderer,
      snapshot,
    };
    return result;
  }

  #noOp(
    options: BuildOptions,
    changedPaths: number,
    started: number,
    parsedPages = 0,
    contentMs = 0,
  ): BuildResult {
    const state = this.#state;
    if (!state) throw new Error("Inkpath build engine has no compiled state");
    const elapsedMs = performance.now() - started;
    const result: BuildResult = {
      ...withoutTimings(state.result),
      elapsedMs,
      incremental: incrementalStats("noop", changedPaths, { parsedPages }),
      ...(options.profile ? { timings: { ...emptyTimings(elapsedMs), contentMs } } : {}),
    };
    state.result = result;
    return result;
  }

  async #reconcileContent(
    normalized: readonly string[],
    options: BuildOptions,
    started: number,
    prefetchedChanges?: readonly SourceChange[],
    prefetchedContentMs = 0,
  ): Promise<BuildResult> {
    const state = this.#state;
    if (!state) throw new Error("Inkpath build engine has no compiled state");

    const config = reconciliationConfig(state);
    const configMs = 0;
    let phaseStarted = performance.now();
    const caseAliases = createCaseAliasLookup(state.result.site);
    const changes =
      prefetchedChanges ??
      (await mapConcurrentOrdered(normalized, (changedPath) =>
        readReconciliationChange(state.result.site, config, changedPath, caseAliases),
      ));
    const parsedPages = changes.filter((change) => change.raw !== undefined).length;
    const site = reconcileSiteSources(state.result.site, config, changes);
    const contentMs = prefetchedContentMs + performance.now() - phaseStarted;

    const reconciled = await renderReconciledSite(
      state,
      site,
      new Set(changes.map((change) => change.relativePath)),
      this.#markdownRenderer,
    );
    if (
      Boolean(reconciled.diagrams) !== Boolean(state.result.diagrams) ||
      Boolean(reconciled.math) !== Boolean(state.result.math) ||
      (reconciled.diagrams > 0 && !state.snapshot.mermaidEntry)
    ) {
      return this.#fullBuild(options, "full", normalized.length, started);
    }

    let assetsMs = reconciled.assetsMs;
    const outputChanges: OutputFileChange[] = [];
    phaseStarted = performance.now();
    for (const [asset, contents] of reconciled.assets) {
      if (!(await outputAssetMatches(config.outputDir, asset, contents))) {
        outputChanges.push({ contents, relativePath: `_content/${asset}` });
      }
    }
    assetsMs += performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const previousOutputs = state.generatedOutputHashes
      ? undefined
      : renderSharedOutputs(state.result.site, state.siteRenderer);
    const previousHashes =
      state.generatedOutputHashes ??
      new Map([...previousOutputs!].map(([relativePath, output]) => [relativePath, output.hash]));
    const siteRenderer = createSiteRenderer(site);
    const nextSnapshot: BuildSnapshot = {
      ...state.snapshot,
      renders: reconciled.renders,
    };
    const nextOutputs = renderSharedOutputs(site, siteRenderer);
    let renderedDocuments = 1; // 404.html is the shared HTML document.
    for (const [relativePath, output] of nextOutputs) {
      if (previousHashes.get(relativePath) === output.hash) continue;
      outputChanges.push({ contents: output.contents, relativePath });
    }

    const previousNeighbors = createPageNeighborIndex(state.result.site);
    const neighbors = createPageNeighborIndex(site);
    const documentGlobalsEqual = sameDocumentGlobals(state.result.site, site);
    for (const page of site.pages) {
      const render = reconciled.renders.get(page);
      if (!render) throw new Error(`missing render state for ${page.relativePath}`);
      const previous = state.result.site.pageBySource.get(page.relativePath);
      const previousRender = previous ? state.snapshot.renders.get(previous) : undefined;
      if (
        previous &&
        previousRender &&
        sameDocumentDependencies(
          previous,
          page,
          previousRender,
          render,
          previousNeighbors,
          neighbors,
          documentGlobalsEqual,
        )
      ) {
        continue;
      }
      outputChanges.push({
        contents: siteRenderer.document(page, {
          ...(nextSnapshot.commitSha ? { commitSha: nextSnapshot.commitSha } : {}),
          diagrams: render.diagrams,
          math: render.math,
          ...(nextSnapshot.mermaidEntry ? { mermaidEntry: nextSnapshot.mermaidEntry } : {}),
        }),
        relativePath: routeOutputPath(page.route),
      });
      renderedDocuments += 1;
    }
    const documentRenderMs = performance.now() - phaseStarted;

    phaseStarted = performance.now();
    const liveDocumentPaths = new Set(site.pages.map((page) => routeOutputPath(page.route)));
    const removedOutputPaths = new Set(
      state.result.site.pages
        .map((page) => routeOutputPath(page.route))
        .filter((relativePath) => !liveDocumentPaths.has(relativePath)),
    );
    for (const relativePath of previousHashes.keys()) {
      if (!nextOutputs.has(relativePath)) removedOutputPaths.add(relativePath);
    }
    for (const relativePath of removedOutputPaths) {
      const contents = await readPublicOutput(config.publicDir, relativePath);
      if (contents === undefined) {
        outputChanges.push({ relativePath });
      } else {
        outputChanges.push({ contents, relativePath });
      }
    }
    await replaceOutputFiles(config.outputDir, outputChanges);
    const outputWriteMs = performance.now() - phaseStarted;

    const elapsedMs = performance.now() - started;
    const result: BuildResult = {
      diagrams: reconciled.diagrams,
      elapsedMs,
      incremental: incrementalStats("partial", normalized.length, {
        parsedPages,
        renderedDocuments,
        renderedMarkdown: reconciled.renderedMarkdown,
        writtenFiles: outputChanges.length,
      }),
      math: reconciled.math,
      orphans: orphanPages(site).length,
      pages: site.pages.length,
      site,
      ...(options.profile
        ? {
            timings: {
              assetsMs,
              configMs,
              contentMs,
              documentRenderMs,
              graphMs: reconciled.graphMs,
              markdownMs: reconciled.markdownMs,
              outputWriteMs,
              publishMs: 0,
              totalMs: elapsedMs,
            },
          }
        : {}),
    };
    state.generatedOutputHashes = new Map(
      [...nextOutputs].map(([relativePath, output]) => [relativePath, output.hash]),
    );
    state.incoming = reconciled.incoming;
    state.navigationOrder = reconciled.navigationOrder;
    state.result = result;
    state.siteRenderer = siteRenderer;
    state.snapshot = nextSnapshot;
    return result;
  }

  async #rebuild(changedPaths: readonly string[], options: BuildOptions): Promise<BuildResult> {
    const started = performance.now();
    if (!this.#state) return this.#fullBuild(options, "clean", changedPaths.length, started);

    const state = this.#state;
    const normalized = normalizedChangedPaths(state.result.site.config.projectRoot, changedPaths);
    if (options.write !== false) {
      if (
        !state.snapshot.wroteOutput ||
        !(await hasPublishedOutput(state.result.site.config.outputDir))
      ) {
        return this.#fullBuild(options, "full", normalized.length, started);
      }
    }
    if (options.write !== false && options.commitSha !== state.snapshot.commitSha) {
      return this.#fullBuild(options, "full", normalized.length, started);
    }
    if (!normalized.length) {
      return this.#noOp(options, 0, started);
    }

    if (options.write === false) {
      return this.#fullBuild(options, "full", normalized.length, started);
    }

    const { config } = state.result.site;
    if (
      normalized.some(
        (changedPath) =>
          !isPathWithin(config.contentDir, changedPath) ||
          path.extname(changedPath).toLowerCase() !== ".md",
      )
    ) {
      return this.#fullBuild(options, "full", normalized.length, started);
    }
    if (normalized.length !== 1) return this.#reconcileContent(normalized, options, started);

    const changedPath = normalized[0] as string;
    const source = toPosix(path.relative(config.contentDir, changedPath));
    const page = state.result.site.pageBySource.get(source);
    const contentStarted = performance.now();
    const change = await readReconciliationChange(state.result.site, config, changedPath);
    if (
      change.raw === undefined ||
      change.relativePath !== source ||
      change.replacedRelativePath !== undefined ||
      !page ||
      page.kind !== "page"
    ) {
      return this.#reconcileContent(
        normalized,
        options,
        started,
        [change],
        performance.now() - contentStarted,
      );
    }
    const raw = change.raw;
    const update = parsePageUpdate(raw, page);
    const contentMs = performance.now() - contentStarted;
    const anyChange = Object.values(update.changes).some(Boolean);
    if (!anyChange) return this.#noOp(options, normalized.length, started, 1, contentMs);
    const incrementalMetadataUpdate = supportsIncrementalMetadataUpdate(page, update);
    if (
      (update.requiresStructuralRebuild || update.changes.attributes) &&
      !incrementalMetadataUpdate
    ) {
      return this.#reconcileContent(normalized, options, started);
    }

    const previousRender = state.snapshot.renders.get(page);
    if (!previousRender) throw new Error(`missing render state for ${page.relativePath}`);
    let nextHeadings = page.headings;
    let nextRender = previousRender;
    let markdownMs = 0;
    let renderedMarkdown = 0;
    const candidateAssets = new Map<string, Uint8Array>();
    let candidateRender: MarkdownRenderResult | undefined;
    if (update.changes.body) {
      const candidatePage: Page = {
        ...page,
        attributes: update.attributes,
        backlinks: [...page.backlinks],
        body: update.body,
        headings: [],
        order: update.order,
        readingMinutes: update.readingMinutes,
        rendered: "",
        slug: update.slug,
        summary: update.summary,
        title: update.title,
      };
      const markdownStarted = performance.now();
      candidateRender = this.#markdownRenderer(candidatePage, state.result.site);
      markdownMs = performance.now() - markdownStarted;
      renderedMarkdown = 1;
      nextHeadings = candidatePage.headings;
      nextRender = candidateRender;
    }

    const nextDiagrams = state.result.diagrams - previousRender.diagrams + nextRender.diagrams;
    const nextMath = state.result.math - previousRender.math + nextRender.math;
    if (
      Boolean(nextDiagrams) !== Boolean(state.result.diagrams) ||
      Boolean(nextMath) !== Boolean(state.result.math) ||
      (nextDiagrams > 0 && !state.snapshot.mermaidEntry)
    ) {
      return this.#fullBuild(options, "full", normalized.length, started);
    }

    const graphStarted = performance.now();
    if (candidateRender) {
      validateCandidateAnchors(state, page, candidateRender);
      for (const [asset, contents] of await validateCandidateAssets(
        state.result.site,
        page,
        candidateRender,
      )) {
        candidateAssets.set(asset, contents);
      }
      nextRender = normalizeRender(state.result.site, candidateRender);
    }
    const previousTargets = referencedTargets(state.result.site, page, previousRender);
    const nextTargets = referencedTargets(state.result.site, page, nextRender);
    const backlinkUpdates = new Map<Page, Page[]>();
    const navigationChanged = update.changes.title || update.changes.order;
    const nextNavigationOrder = navigationChanged
      ? createNavigationOrder(state.result.site)
      : state.navigationOrder;
    let orphanDelta = 0;
    let orphanMembershipChanged = false;
    for (const target of new Set([...previousTargets, ...nextTargets])) {
      const hadReference = previousTargets.has(target);
      const hasReference = nextTargets.has(target);
      if (hadReference === hasReference) continue;
      const previousBacklinks = target.backlinks;
      const nextBacklinks = hasReference
        ? [...previousBacklinks, page]
        : previousBacklinks.filter((backlink) => backlink !== page);
      nextBacklinks.sort(
        (left, right) =>
          (state.navigationOrder.get(left) ?? 0) - (state.navigationOrder.get(right) ?? 0),
      );
      if (target.kind === "page") {
        const wasOrphan = previousBacklinks.length === 0;
        const isOrphan = nextBacklinks.length === 0;
        orphanDelta += Number(isOrphan) - Number(wasOrphan);
        orphanMembershipChanged ||= wasOrphan !== isOrphan;
      }
      backlinkUpdates.set(target, nextBacklinks);
    }
    if (navigationChanged) {
      for (const target of new Set([...previousTargets, ...nextTargets])) {
        const backlinks = backlinkUpdates.get(target) ?? target.backlinks;
        backlinkUpdates.set(
          target,
          [...backlinks].sort(
            (left, right) =>
              (nextNavigationOrder.get(left) ?? 0) - (nextNavigationOrder.get(right) ?? 0),
          ),
        );
      }
    }
    const graphMs = performance.now() - graphStarted;

    const oldPageFields = previousPageFields(page);
    const parent = page.parent;
    const oldChildren = parent ? [...parent.children] : undefined;
    const previousPaginationDocuments =
      navigationChanged && oldChildren ? paginationDependents(page, oldChildren) : new Set<Page>();
    const oldBacklinks = new Map(
      [...backlinkUpdates].map(([target]) => [target, target.backlinks] as const),
    );
    const rollback = () => {
      setPageFields(page, oldPageFields);
      for (const [target, backlinks] of oldBacklinks) target.backlinks = backlinks;
      if (parent && oldChildren) parent.children.splice(0, parent.children.length, ...oldChildren);
    };

    setPageFields(page, {
      attributes: update.attributes,
      body: update.body,
      headings: nextHeadings,
      order: update.order,
      readingMinutes: update.readingMinutes,
      rendered: nextRender.html,
      slug: update.slug,
      summary: update.summary,
      title: update.title,
    });
    for (const [target, backlinks] of backlinkUpdates) target.backlinks = backlinks;
    if (navigationChanged && parent) parent.children.sort(compareSiblings);

    const documents = new Set<Page>([page, ...backlinkUpdates.keys()]);
    if (
      (update.changes.summary ||
        update.changes.readingMinutes ||
        update.changes.title ||
        update.changes.order) &&
      parent
    ) {
      documents.add(parent);
    }
    if (navigationChanged && parent) {
      for (const document of previousPaginationDocuments) documents.add(document);
      for (const document of paginationDependents(page, parent.children)) documents.add(document);
    }
    const orderedDocuments = [...documents].sort(
      (left, right) => (nextNavigationOrder.get(left) ?? 0) - (nextNavigationOrder.get(right) ?? 0),
    );
    const outputChanges: OutputFileChange[] = [];
    const documentRenderStarted = performance.now();
    let nextSiteRenderer = state.siteRenderer;
    try {
      for (const [asset, contents] of candidateAssets) {
        if (!(await outputAssetMatches(config.outputDir, asset, contents))) {
          outputChanges.push({ contents, relativePath: `_content/${asset}` });
        }
      }
      if (navigationChanged) nextSiteRenderer = createSiteRenderer(state.result.site);
      for (const document of orderedDocuments) {
        const render = document === page ? nextRender : state.snapshot.renders.get(document);
        if (!render) throw new Error(`missing render state for ${document.relativePath}`);
        outputChanges.push({
          contents: nextSiteRenderer.document(document, {
            ...(state.snapshot.commitSha ? { commitSha: state.snapshot.commitSha } : {}),
            diagrams: render.diagrams,
            math: render.math,
            ...(state.snapshot.mermaidEntry ? { mermaidEntry: state.snapshot.mermaidEntry } : {}),
          }),
          relativePath: routeOutputPath(document.route),
        });
      }
      if (orphanMembershipChanged || (update.changes.title && page.backlinks.length === 0)) {
        outputChanges.push({
          contents: renderOrphanReport(state.result.site),
          relativePath: "_inkpath/orphans.json",
        });
      }
      if ((update.changes.summary || update.changes.title) && hasDate(page) && config.site.url) {
        const rss = renderRss(state.result.site);
        const atom = renderAtom(state.result.site);
        if (rss) outputChanges.push({ contents: rss, relativePath: "rss.xml" });
        if (atom) outputChanges.push({ contents: atom, relativePath: "atom.xml" });
      }
    } catch (error) {
      rollback();
      throw error;
    }
    const documentRenderMs = performance.now() - documentRenderStarted;

    const outputStarted = performance.now();
    try {
      await replaceOutputFiles(config.outputDir, outputChanges);
    } catch (error) {
      rollback();
      throw error;
    }
    const outputWriteMs = performance.now() - outputStarted;

    state.snapshot.renders.set(page, nextRender);
    if (nextRender !== previousRender) {
      replaceIncomingSource(state.incoming, page, previousRender, nextRender);
    }
    state.navigationOrder = nextNavigationOrder;
    state.siteRenderer = nextSiteRenderer;
    state.generatedOutputHashes = undefined;
    const elapsedMs = performance.now() - started;
    const result: BuildResult = {
      ...withoutTimings(state.result),
      diagrams: nextDiagrams,
      elapsedMs,
      incremental: incrementalStats("partial", normalized.length, {
        parsedPages: 1,
        renderedDocuments: orderedDocuments.length,
        renderedMarkdown,
        writtenFiles: outputChanges.length,
      }),
      math: nextMath,
      orphans: state.result.orphans + orphanDelta,
      ...(options.profile
        ? {
            timings: {
              assetsMs: 0,
              configMs: 0,
              contentMs,
              documentRenderMs,
              graphMs,
              markdownMs,
              outputWriteMs,
              publishMs: 0,
              totalMs: elapsedMs,
            },
          }
        : {}),
    };
    state.result = result;
    return result;
  }
}

export function createBuildEngine(projectDirectory = "."): BuildEngine {
  return new PersistentBuildEngine(projectDirectory);
}
