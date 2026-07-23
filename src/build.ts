import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { copyKatexAssets, copyMermaidAssets } from "./assets.js";
import { mapConcurrentOrdered } from "./concurrency.js";
import { loadConfig } from "./config.js";
import { loadSite } from "./content.js";
import {
  orphanPages,
  renderAtom,
  renderOrphanReport,
  renderRss,
  renderSitemap,
} from "./discovery.js";
import { renderMarkdown, type MarkdownRenderResult } from "./markdown.js";
import { createSiteRenderer } from "./render.js";
import { renderThemeCss } from "./theme.js";
import type { BuildResult, BuildTimings, Page, InkpathConfig, Site } from "./types.js";
import { isPathWithin, pathsOverlap } from "./utils.js";

export type BuildOptions = {
  commitSha?: string;
  profile?: boolean;
  write?: boolean;
};

type OutputTimings = Pick<
  BuildTimings,
  "assetsMs" | "documentRenderMs" | "outputWriteMs" | "publishMs"
>;

type PageRender = MarkdownRenderResult;

type CopyEntry = {
  destination: string;
  source: string;
};

type DirectoryCopyPlan = {
  directories: string[];
  files: CopyEntry[];
};

type PageOutput = {
  destination: string;
  directory: string;
  page: Page;
  render: PageRender;
};

export type BuildSnapshot = {
  commitSha?: string;
  hasConfiguredSiteDescription: boolean;
  hasConfiguredSiteTitle: boolean;
  mermaidEntry?: string;
  renders: Map<Page, PageRender>;
  wroteOutput: boolean;
};

type OutputResult = OutputTimings & {
  mermaidEntry?: string;
};

const OUTPUT_WRITE_CONCURRENCY = 32;
const OUTPUT_DIRECTORY_CONCURRENCY = 32;
const ASSET_COPY_CONCURRENCY = 32;
const ASSET_VALIDATION_CONCURRENCY = 32;
const buildSnapshots = new WeakMap<Site, BuildSnapshot>();

export function buildSnapshot(site: Site): BuildSnapshot | undefined {
  return buildSnapshots.get(site);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

async function validateAssets(
  config: InkpathConfig,
  renders: Map<Page, PageRender>,
): Promise<void> {
  const owners = new Map<string, Page>();
  for (const [page, render] of renders) {
    for (const asset of render.assets) if (!owners.has(asset)) owners.set(asset, page);
  }
  await mapConcurrentOrdered(
    [...owners],
    async ([asset, page]) => {
      const absolutePath = path.resolve(config.contentDir, asset);
      if (!isPathWithin(config.contentDir, absolutePath)) {
        throw new Error(`${page.relativePath}: missing local asset ${asset}`);
      }
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          throw new Error(`${page.relativePath}: missing local asset ${asset}`);
        }
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`${page.relativePath}: local asset must be a regular file: ${asset}`);
      }
    },
    ASSET_VALIDATION_CONCURRENCY,
  );
}

function validateAnchors(renders: Map<Page, PageRender>): void {
  for (const [page, render] of renders) {
    for (const reference of render.internalReferences) {
      if (!reference.fragment) continue;
      let fragment: string;
      try {
        fragment = decodeURIComponent(reference.fragment);
      } catch {
        throw new Error(`${page.relativePath}: malformed anchor #${reference.fragment}`);
      }
      const targetRender = renders.get(reference.target);
      if (!targetRender?.anchors.has(fragment)) {
        throw new Error(
          `${page.relativePath}: missing anchor #${fragment} in ${reference.target.relativePath}`,
        );
      }
    }
  }
}

async function planDirectoryCopy(
  source: string,
  destination: string,
  skipMarkdown: boolean,
): Promise<DirectoryCopyPlan> {
  const entries = await readdir(source, { withFileTypes: true });
  const plan: DirectoryCopyPlan = { directories: [], files: [] };
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not supported: ${sourcePath}`);
    } else if (entry.isDirectory()) {
      plan.directories.push(destinationPath);
      const nested = await planDirectoryCopy(sourcePath, destinationPath, skipMarkdown);
      plan.directories.push(...nested.directories);
      plan.files.push(...nested.files);
    } else if (entry.isFile() && (!skipMarkdown || !entry.name.toLowerCase().endsWith(".md"))) {
      plan.files.push({ destination: destinationPath, source: sourcePath });
    }
  }
  return plan;
}

function directoryDepth(root: string, directory: string): number {
  return path.relative(root, directory).split(path.sep).filter(Boolean).length;
}

async function createPlannedDirectories(
  root: string,
  directories: readonly string[],
  created: Set<string>,
): Promise<void> {
  const unique = [...new Set(directories)].filter((directory) => !created.has(directory));
  unique.sort(
    (left, right) =>
      directoryDepth(root, left) - directoryDepth(root, right) || left.localeCompare(right),
  );

  let start = 0;
  while (start < unique.length) {
    const depth = directoryDepth(root, unique[start] as string);
    let end = start + 1;
    while (end < unique.length && directoryDepth(root, unique[end] as string) === depth) end += 1;
    await mapConcurrentOrdered(
      unique.slice(start, end),
      async (directory) => mkdir(directory),
      OUTPUT_DIRECTORY_CONCURRENCY,
    );
    for (const directory of unique.slice(start, end)) created.add(directory);
    start = end;
  }
}

async function copyPlannedFiles(files: readonly CopyEntry[]): Promise<void> {
  await mapConcurrentOrdered(
    files,
    async ({ source, destination }) => copyFile(source, destination),
    ASSET_COPY_CONCURRENCY,
  );
}

function planPageOutputs(stage: string, renders: ReadonlyMap<Page, PageRender>): PageOutput[] {
  return [...renders].map(([page, render]) => {
    const destination = outputPath(stage, page.route);
    return { destination, directory: path.dirname(destination), page, render };
  });
}

async function validatePublicDirectory(publicDir: string): Promise<void> {
  if (!(await exists(publicDir))) return;
  const inspect = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`public cannot contain symbolic links: ${entryPath}`);
      if (entry.isDirectory()) await inspect(entryPath);
    }
  };
  await inspect(publicDir);
}

function outputPath(outputRoot: string, route: string): string {
  if (route === "/") return path.join(outputRoot, "index.html");
  return path.join(outputRoot, route.replace(/^\//, ""), "index.html");
}

async function writeOutput(
  site: Site,
  config: InkpathConfig,
  renders: Map<Page, PageRender>,
  diagrams: number,
  math: number,
  commitSha?: string,
  profile = false,
): Promise<OutputResult> {
  const outputStarted = performance.now();
  let assetsMs = 0;
  let documentRenderMs = 0;
  let mermaidEntry: string | undefined;
  let publishMs = 0;
  const outputParent = path.dirname(config.outputDir);
  const outputName = path.basename(config.outputDir);
  await mkdir(outputParent, { recursive: true });
  const stage = await mkdtemp(path.join(outputParent, `.${outputName}.inkpath-stage-`));
  let previous = path.join(outputParent, `.${outputName}.inkpath-previous-${randomUUID()}`);
  while (await exists(previous)) {
    previous = path.join(outputParent, `.${outputName}.inkpath-previous-${randomUUID()}`);
  }

  for (const [label, scratch] of [
    ["build stage", stage],
    ["previous output", previous],
  ] as const) {
    if (pathsOverlap(scratch, config.contentDir) || pathsOverlap(scratch, config.publicDir)) {
      await rm(stage, { recursive: true, force: true });
      throw new Error(`${label} cannot overlap content or public directories`);
    }
  }

  try {
    const assetsStarted = performance.now();
    const createdDirectories = new Set([stage]);
    if (await exists(config.publicDir)) {
      const publicPlan = await planDirectoryCopy(config.publicDir, stage, false);
      await createPlannedDirectories(stage, publicPlan.directories, createdDirectories);
      await copyPlannedFiles(publicPlan.files);
    }
    await createPlannedDirectories(stage, [path.join(stage, "_inkpath")], createdDirectories);
    if (!config.theme.stylesheet) {
      await writeFile(
        path.join(stage, "_inkpath", "theme.css"),
        renderThemeCss(config.theme).trimStart(),
        "utf8",
      );
    }

    const contentAssets = path.join(stage, "_content");
    const contentPlan = await planDirectoryCopy(config.contentDir, contentAssets, true);
    await createPlannedDirectories(
      stage,
      [contentAssets, ...contentPlan.directories],
      createdDirectories,
    );
    await copyPlannedFiles(contentPlan.files);

    if (diagrams) {
      mermaidEntry = await copyMermaidAssets(path.join(stage, "_inkpath"));
    }
    if (math) await copyKatexAssets(path.join(stage, "_inkpath", "katex"));
    assetsMs = performance.now() - assetsStarted;

    const siteRenderer = createSiteRenderer(site);
    await mapConcurrentOrdered(
      planPageOutputs(stage, renders),
      async ({ destination, directory, page, render }) => {
        const directoryReady =
          directory === stage ? Promise.resolve() : mkdir(directory, { recursive: true });
        const renderStarted = profile ? performance.now() : 0;
        let document: string;
        try {
          document = siteRenderer.document(page, {
            ...(commitSha ? { commitSha } : {}),
            diagrams: render.diagrams,
            math: render.math,
            ...(mermaidEntry ? { mermaidEntry } : {}),
          });
        } finally {
          if (profile) documentRenderMs += performance.now() - renderStarted;
          await directoryReady;
        }
        await writeFile(destination, document, "utf8");
      },
      OUTPUT_WRITE_CONCURRENCY,
    );

    const firstPage = renders.keys().next().value as Page | undefined;
    if (!firstPage) throw new Error("cannot render an empty site");
    const discoveryRenderStarted = profile ? performance.now() : 0;
    const notFound = siteRenderer.notFound();
    const orphanReport = renderOrphanReport(site);
    const sitemap = renderSitemap(site);
    const rss = renderRss(site);
    const atom = renderAtom(site);
    if (profile) documentRenderMs += performance.now() - discoveryRenderStarted;
    await writeFile(path.join(stage, "404.html"), notFound, "utf8");
    await writeFile(path.join(stage, "_inkpath", "orphans.json"), orphanReport, "utf8");
    if (sitemap) await writeFile(path.join(stage, "sitemap.xml"), sitemap, "utf8");
    if (rss) await writeFile(path.join(stage, "rss.xml"), rss, "utf8");
    if (atom) await writeFile(path.join(stage, "atom.xml"), atom, "utf8");

    const publishStarted = performance.now();
    let movedPrevious = false;
    if (await exists(config.outputDir)) {
      await rename(config.outputDir, previous);
      movedPrevious = true;
    }
    try {
      await rename(stage, config.outputDir);
    } catch (error) {
      if (movedPrevious && !(await exists(config.outputDir)))
        await rename(previous, config.outputDir);
      throw error;
    }
    if (movedPrevious) {
      try {
        await rm(previous, { recursive: true, force: true });
      } catch {
        // The new output is already published. A cleanup error must not report
        // a failed build and leave callers caching the previous graph state.
      }
    }
    publishMs = performance.now() - publishStarted;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  const totalOutputMs = performance.now() - outputStarted;
  return {
    assetsMs,
    documentRenderMs,
    ...(mermaidEntry ? { mermaidEntry } : {}),
    outputWriteMs: Math.max(0, totalOutputMs - assetsMs - documentRenderMs - publishMs),
    publishMs,
  };
}

export async function buildSite(
  projectDirectory = ".",
  options: BuildOptions = {},
): Promise<BuildResult> {
  const started = performance.now();
  let phaseStarted = started;
  const config = await loadConfig(projectDirectory);
  const hasConfiguredSiteDescription = config.site.description !== undefined;
  const hasConfiguredSiteTitle = config.site.title !== undefined;
  await validatePublicDirectory(config.publicDir);
  const configMs = performance.now() - phaseStarted;
  phaseStarted = performance.now();
  const site = await loadSite(config);
  const contentMs = performance.now() - phaseStarted;
  phaseStarted = performance.now();
  const renders = new Map<Page, PageRender>();
  let diagrams = 0;
  let math = 0;

  for (const page of site.pages) {
    const render = renderMarkdown(page, site);
    page.rendered = render.html;
    renders.set(page, render);
    diagrams += render.diagrams;
    math += render.math;
  }
  const markdownMs = performance.now() - phaseStarted;
  phaseStarted = performance.now();
  validateAnchors(renders);
  await validateAssets(config, renders);
  const backlinks = new Map(site.pages.map((page) => [page, new Set<Page>()]));
  for (const [source, render] of renders) {
    for (const reference of render.internalReferences) {
      if (reference.target !== source) backlinks.get(reference.target)?.add(source);
    }
  }
  const navigationOrder = new Map(site.pages.map((page, index) => [page, index]));
  for (const page of site.pages) {
    page.backlinks = [...(backlinks.get(page) ?? [])].sort(
      (left, right) => (navigationOrder.get(left) ?? 0) - (navigationOrder.get(right) ?? 0),
    );
  }
  const orphans = orphanPages(site).length;
  const graphMs = performance.now() - phaseStarted;
  let outputResult: OutputResult = {
    assetsMs: 0,
    documentRenderMs: 0,
    outputWriteMs: 0,
    publishMs: 0,
  };
  if (options.write !== false) {
    outputResult = await writeOutput(
      site,
      config,
      renders,
      diagrams,
      math,
      options.commitSha,
      options.profile,
    );
  }

  const elapsedMs = performance.now() - started;
  const timings: BuildTimings | undefined = options.profile
    ? {
        assetsMs: outputResult.assetsMs,
        configMs,
        contentMs,
        documentRenderMs: outputResult.documentRenderMs,
        graphMs,
        markdownMs,
        outputWriteMs: outputResult.outputWriteMs,
        publishMs: outputResult.publishMs,
        totalMs: elapsedMs,
      }
    : undefined;

  buildSnapshots.set(site, {
    ...(options.commitSha ? { commitSha: options.commitSha } : {}),
    hasConfiguredSiteDescription,
    hasConfiguredSiteTitle,
    ...(outputResult.mermaidEntry ? { mermaidEntry: outputResult.mermaidEntry } : {}),
    renders,
    wroteOutput: options.write !== false,
  });

  return {
    diagrams,
    elapsedMs,
    math,
    orphans,
    pages: site.pages.length,
    site,
    ...(timings ? { timings } : {}),
  };
}
