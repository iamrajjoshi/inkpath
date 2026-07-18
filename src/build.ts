import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { loadConfig } from "./config.js";
import { loadSite } from "./content.js";
import { renderMarkdown } from "./markdown.js";
import { renderDocument, renderNotFound } from "./render.js";
import { mermaidClientSource, renderThemeCss } from "./theme.js";
import type { BuildResult, Page, InkpathConfig, Site } from "./types.js";
import { isPathWithin, pathsOverlap } from "./utils.js";

type BuildOptions = {
  write?: boolean;
};

type PageRender = ReturnType<typeof renderMarkdown>;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function validateAssets(
  config: InkpathConfig,
  renders: Map<Page, PageRender>,
): Promise<void> {
  for (const [page, render] of renders) {
    for (const asset of render.assets) {
      const absolutePath = path.resolve(config.contentDir, asset);
      if (!isPathWithin(config.contentDir, absolutePath) || !(await exists(absolutePath))) {
        throw new Error(`${page.relativePath}: missing local asset ${asset}`);
      }
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`${page.relativePath}: local asset must be a regular file: ${asset}`);
      }
    }
  }
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

async function copyDirectory(
  source: string,
  destination: string,
  skipMarkdown: boolean,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not supported: ${sourcePath}`);
    } else if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyDirectory(sourcePath, destinationPath, skipMarkdown);
    } else if (entry.isFile() && (!skipMarkdown || !entry.name.toLowerCase().endsWith(".md"))) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath);
    }
  }
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

async function bundleMermaid(outputRoot: string): Promise<void> {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await esbuild({
    absWorkingDir: moduleRoot,
    bundle: true,
    format: "esm",
    minify: true,
    outfile: path.join(outputRoot, "_inkpath", "inkpath.js"),
    platform: "browser",
    stdin: {
      contents: mermaidClientSource,
      loader: "js",
      resolveDir: moduleRoot,
      sourcefile: "inkpath-mermaid-client.js",
    },
    target: ["es2022"],
  });
}

async function writeOutput(
  site: Site,
  config: InkpathConfig,
  renders: Map<Page, PageRender>,
  diagrams: number,
): Promise<void> {
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
    if (await exists(config.publicDir)) await copyDirectory(config.publicDir, stage, false);
    await mkdir(path.join(stage, "_inkpath"), { recursive: true });
    await writeFile(
      path.join(stage, "_inkpath", "theme.css"),
      renderThemeCss(config.theme).trimStart(),
      "utf8",
    );

    const contentAssets = path.join(stage, "_content");
    await mkdir(contentAssets, { recursive: true });
    await copyDirectory(config.contentDir, contentAssets, true);

    for (const [page, render] of renders) {
      const destination = outputPath(stage, page.route);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, renderDocument(site, page, render.diagrams), "utf8");
    }

    const firstPage = renders.keys().next().value as Page | undefined;
    if (!firstPage) throw new Error("cannot render an empty site");
    await writeFile(path.join(stage, "404.html"), renderNotFound(site), "utf8");
    if (diagrams) await bundleMermaid(stage);

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
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function buildSite(
  projectDirectory = ".",
  options: BuildOptions = {},
): Promise<BuildResult> {
  const started = performance.now();
  const config = await loadConfig(projectDirectory);
  await validatePublicDirectory(config.publicDir);
  const site = await loadSite(config);
  const renders = new Map<Page, PageRender>();
  let diagrams = 0;

  for (const page of site.pages) {
    const render = renderMarkdown(page, site);
    page.rendered = render.html;
    renders.set(page, render);
    diagrams += render.diagrams;
  }
  validateAnchors(renders);
  await validateAssets(config, renders);
  if (options.write !== false) await writeOutput(site, config, renders, diagrams);

  return {
    diagrams,
    elapsedMs: performance.now() - started,
    pages: site.pages.length,
    site,
  };
}
