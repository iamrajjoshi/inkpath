import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { InkpathConfig } from "./types.js";
import { assertInsideProject, isPathWithin, normalizeBasePath, pathsOverlap } from "./utils.js";

type RawConfig = {
  content?: string;
  output?: string;
  public?: string;
  site?: {
    title?: string;
    description?: string;
    lang?: string;
    basePath?: string;
    url?: string;
    logo?: string;
  };
  theme?: {
    accent?: string;
    interactive?: string;
    subtle?: string;
  };
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectDirectory(projectRoot: string, target: string, label: string): Promise<string> {
  const parts = path.relative(projectRoot, target).split(path.sep).filter(Boolean);
  let cursor = projectRoot;

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(cursor, parts[index] ?? "");
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`${label} cannot be or pass through a symbolic link`);
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

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
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
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a relative path inside public`);
  }
  return segments.join("/");
}

export async function loadConfig(projectDirectory = "."): Promise<InkpathConfig> {
  const projectRoot = await realpath(path.resolve(projectDirectory));
  const configPath = path.join(projectRoot, "inkpath.yaml");
  let raw: RawConfig = {};

  if (await exists(configPath)) {
    const parsed = YAML.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("inkpath.yaml must contain a YAML mapping");
    }
    raw = parsed as RawConfig;
  }

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
  const site = raw.site ?? {};
  const title = optionalString(site.title, "site.title");
  const description = optionalString(site.description, "site.description");
  const url = optionalString(site.url, "site.url");
  const logo = optionalPublicAsset(site.logo, "site.logo");
  if (logo) {
    const logoPath = path.resolve(publicDir, ...logo.split("/"));
    if (!(await exists(logoPath))) throw new Error(`site.logo does not exist in public: ${logo}`);
    const info = await lstat(logoPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`site.logo must be a regular file in public: ${logo}`);
    }
  }
  if (raw.theme !== undefined && (typeof raw.theme !== "object" || raw.theme === null || Array.isArray(raw.theme))) {
    throw new Error("theme must be a YAML mapping");
  }
  const theme = raw.theme ?? {};
  return {
    projectRoot,
    contentDir,
    outputDir,
    publicDir,
    site: {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      lang: optionalString(site.lang, "site.lang") ?? "en",
      basePath: normalizeBasePath(optionalString(site.basePath, "site.basePath")),
      ...(url ? { url } : {}),
      ...(logo ? { logo } : {}),
    },
    theme: {
      accent: optionalHexColor(theme.accent, "theme.accent") ?? "#f36f21",
      interactive: optionalHexColor(theme.interactive, "theme.interactive") ?? "#a54016",
      subtle: optionalHexColor(theme.subtle, "theme.subtle") ?? "#fff0e8",
    },
  };
}
