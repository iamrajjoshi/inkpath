import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { assertKnownKeys } from "./schema.js";
import type { InkpathConfig } from "./types.js";
import { assertInsideProject, isPathWithin, normalizeBasePath, pathsOverlap } from "./utils.js";

type YamlMapping = Record<string, unknown>;

const CONFIG_KEYS = ["content", "output", "public", "site", "markdown", "theme"] as const;
const SITE_KEYS = [
  "author",
  "title",
  "description",
  "lang",
  "basePath",
  "url",
  "logo",
  "image",
] as const;
const MARKDOWN_KEYS = ["math"] as const;
const THEME_KEYS = [
  "accent",
  "interactive",
  "interactiveHover",
  "showListDetails",
  "showPageDetails",
  "stylesheet",
  "subtle",
] as const;

function isYamlMapping(value: unknown): value is YamlMapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalYamlMapping(value: unknown, label: string): YamlMapping {
  if (value === undefined) return {};
  if (!isYamlMapping(value)) throw new Error(`${label} must be a YAML mapping`);
  return value;
}

async function readRawConfig(projectRoot: string): Promise<YamlMapping> {
  const configPath = path.join(projectRoot, "inkpath.yaml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = YAML.parse(source);
  if (!isYamlMapping(parsed)) {
    throw new Error("inkpath.yaml must contain a YAML mapping");
  }
  assertKnownKeys(parsed, CONFIG_KEYS, {
    source: "inkpath.yaml",
    scope: "configuration",
  });
  return parsed;
}

async function resolveProjectDirectory(
  projectRoot: string,
  target: string,
  label: string,
): Promise<string> {
  const parts = path.relative(projectRoot, target).split(path.sep).filter(Boolean);
  let cursor = projectRoot;

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(cursor, parts[index] ?? "");
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink())
        throw new Error(`${label} cannot be or pass through a symbolic link`);
      if (!info.isDirectory()) throw new Error(`${label} must be or pass through directories`);
      const resolved = await realpath(candidate);
      if (!isPathWithin(projectRoot, resolved)) {
        throw new Error(`${label} resolves outside the project root`);
      }
      cursor = resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const unresolved = path.join(cursor, ...parts.slice(index));
      if (!isPathWithin(projectRoot, unresolved)) {
        throw new Error(`${label} resolves outside the project root`);
      }
      return unresolved;
    }
  }

  return cursor;
}

async function resolveWatchDirectory(projectRoot: string, target: string): Promise<string> {
  const parts = path.relative(projectRoot, target).split(path.sep).filter(Boolean);
  let cursor = projectRoot;

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(cursor, parts[index] ?? "");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return cursor;
    }

    // A broken configuration still needs to be recoverable without restarting
    // the dev server. Watching the last verified directory observes the bad
    // entry being replaced, without asking Chokidar to traverse it.
    if (info.isSymbolicLink() || !info.isDirectory()) return cursor;

    const resolved = await realpath(candidate);
    if (!isPathWithin(projectRoot, resolved)) return cursor;
    cursor = resolved;
  }

  return cursor;
}

export async function configuredWatchDirectories(projectDirectory = "."): Promise<string[]> {
  const projectRoot = await realpath(path.resolve(projectDirectory));
  const raw = await readRawConfig(projectRoot);
  const contentName = optionalString(raw.content, "content") ?? "content";
  const publicName = optionalString(raw.public, "public") ?? "public";
  const requestedContentDir = path.resolve(projectRoot, contentName);
  const requestedPublicDir = path.resolve(projectRoot, publicName);
  assertInsideProject(projectRoot, requestedContentDir, "content");
  assertInsideProject(projectRoot, requestedPublicDir, "public");
  return [
    await resolveWatchDirectory(projectRoot, requestedContentDir),
    await resolveWatchDirectory(projectRoot, requestedPublicDir),
  ];
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function optionalSiteUrl(value: unknown): string | undefined {
  const raw = optionalString(value, "site.url");
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("site.url must be an absolute HTTP or HTTPS URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "site.url must be an absolute HTTP or HTTPS origin without credentials, a path, a query, or a fragment",
    );
  }
  return url.href.replace(/\/$/, "");
}

function optionalHexColor(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    throw new Error(`${label} must be a six-digit hexadecimal color`);
  }
  return value.trim().toLowerCase();
}

function optionalPublicAsset(value: unknown, label: string): string | undefined {
  const asset = optionalString(value, label);
  if (asset === undefined) return undefined;
  const segments = asset.split("/");
  if (
    path.posix.isAbsolute(asset) ||
    path.win32.isAbsolute(asset) ||
    asset.includes("\\") ||
    asset.includes("?") ||
    asset.includes("#") ||
    segments.some((segment) => !segment || segment.startsWith("."))
  ) {
    throw new Error(`${label} must be a relative path inside public`);
  }
  return segments.join("/");
}

async function validatePublicFile(publicDir: string, asset: string, label: string): Promise<void> {
  const segments = asset.split("/");
  let cursor = publicDir;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label} does not exist in public: ${asset}`);
      }
      throw error;
    }
    const last = index === segments.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`${label} must be a regular file in public: ${asset}`);
    }
  }
}

export async function loadConfig(projectDirectory = "."): Promise<InkpathConfig> {
  const projectRoot = await realpath(path.resolve(projectDirectory));
  const raw = await readRawConfig(projectRoot);

  const contentName = optionalString(raw.content, "content") ?? "content";
  const outputName = optionalString(raw.output, "output") ?? "site";
  const publicName = optionalString(raw.public, "public") ?? "public";
  const requestedContentDir = path.resolve(projectRoot, contentName);
  const requestedOutputDir = path.resolve(projectRoot, outputName);
  const requestedPublicDir = path.resolve(projectRoot, publicName);

  assertInsideProject(projectRoot, requestedContentDir, "content");
  assertInsideProject(projectRoot, requestedOutputDir, "output");
  assertInsideProject(projectRoot, requestedPublicDir, "public");
  const contentDir = await resolveProjectDirectory(projectRoot, requestedContentDir, "content");
  const outputDir = await resolveProjectDirectory(projectRoot, requestedOutputDir, "output");
  const publicDir = await resolveProjectDirectory(projectRoot, requestedPublicDir, "public");
  if (pathsOverlap(contentDir, outputDir)) {
    throw new Error("content and output directories cannot overlap");
  }
  if (pathsOverlap(publicDir, outputDir)) {
    throw new Error("public and output directories cannot overlap");
  }
  if (pathsOverlap(contentDir, publicDir)) {
    throw new Error("content and public directories cannot overlap");
  }
  const site = optionalYamlMapping(raw.site, "site");
  assertKnownKeys(site, SITE_KEYS, { source: "inkpath.yaml", scope: "site" });
  const author = optionalString(site.author, "site.author");
  const title = optionalString(site.title, "site.title");
  const description = optionalString(site.description, "site.description");
  const url = optionalSiteUrl(site.url);
  const logo = optionalPublicAsset(site.logo, "site.logo");
  const image = optionalPublicAsset(site.image, "site.image");
  if (logo) await validatePublicFile(publicDir, logo, "site.logo");
  if (image) await validatePublicFile(publicDir, image, "site.image");
  const markdown = optionalYamlMapping(raw.markdown, "markdown");
  assertKnownKeys(markdown, MARKDOWN_KEYS, {
    source: "inkpath.yaml",
    scope: "markdown",
  });
  const theme = optionalYamlMapping(raw.theme, "theme");
  assertKnownKeys(theme, THEME_KEYS, { source: "inkpath.yaml", scope: "theme" });
  const stylesheet = optionalPublicAsset(theme.stylesheet, "theme.stylesheet");
  if (stylesheet && !stylesheet.toLowerCase().endsWith(".css")) {
    throw new Error("theme.stylesheet must point to a CSS file in public");
  }
  if (
    stylesheet &&
    [theme.accent, theme.interactive, theme.interactiveHover, theme.subtle].some(
      (value) => value !== undefined,
    )
  ) {
    throw new Error("theme.stylesheet cannot be combined with theme color settings");
  }
  if (stylesheet) await validatePublicFile(publicDir, stylesheet, "theme.stylesheet");
  const showPageDetails = optionalBoolean(theme.showPageDetails, "theme.showPageDetails") ?? true;
  const interactive = optionalHexColor(theme.interactive, "theme.interactive") ?? "#0f766e";
  const interactiveHover =
    optionalHexColor(theme.interactiveHover, "theme.interactiveHover") ??
    (theme.interactive === undefined ? "#0b5f59" : interactive);
  return {
    projectRoot,
    contentDir,
    outputDir,
    publicDir,
    markdown: {
      math: optionalBoolean(markdown.math, "markdown.math") ?? false,
    },
    site: {
      ...(author ? { author } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      lang: optionalString(site.lang, "site.lang") ?? "en",
      basePath: normalizeBasePath(optionalString(site.basePath, "site.basePath")),
      ...(url ? { url } : {}),
      ...(logo ? { logo } : {}),
      ...(image ? { image } : {}),
    },
    theme: {
      accent: optionalHexColor(theme.accent, "theme.accent") ?? "#2dd4bf",
      interactive,
      interactiveHover,
      showListDetails:
        optionalBoolean(theme.showListDetails, "theme.showListDetails") ?? showPageDetails,
      showPageDetails,
      ...(stylesheet ? { stylesheet } : {}),
      subtle: optionalHexColor(theme.subtle, "theme.subtle") ?? "#f0fdfa",
    },
  };
}
