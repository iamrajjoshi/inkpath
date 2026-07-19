import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, version as esbuildVersion } from "esbuild";
import { mermaidClientSource } from "./theme.js";
import { INKPATH_VERSION } from "./version.js";

export type MermaidAssets = {
  directory: string;
  entry: string;
};

const require = createRequire(import.meta.url);
let mermaidAssetsPromise: Promise<MermaidAssets> | undefined;

async function packageVersion(name: string): Promise<string> {
  const packagePath = require.resolve(`${name}/package.json`);
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error(`${name} has no package version`);
  return parsed.version;
}

async function readManifest(directory: string): Promise<MermaidAssets | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      entry?: unknown;
      files?: unknown;
    };
    if (
      typeof parsed.entry !== "string" ||
      !/^inkpath-[A-Z0-9]+\.js$/.test(parsed.entry) ||
      !Array.isArray(parsed.files) ||
      parsed.files.some(
        (file) =>
          typeof file !== "string" ||
          path.posix.isAbsolute(file) ||
          file.split("/").some((segment) => !segment || segment === ".."),
      )
    ) {
      return undefined;
    }
    for (const file of parsed.files as string[]) await readFile(path.join(directory, file));
    return { directory, entry: parsed.entry };
  } catch {
    return undefined;
  }
}

async function createMermaidAssets(): Promise<MermaidAssets> {
  const mermaidVersion = await packageVersion("mermaid");
  const cacheKey = createHash("sha256")
    .update([INKPATH_VERSION, esbuildVersion, mermaidVersion, mermaidClientSource].join("\0"))
    .digest("hex")
    .slice(0, 20);
  const cacheRoot = path.join(os.tmpdir(), "inkpath-assets");
  const directory = path.join(cacheRoot, `mermaid-${cacheKey}`);
  const cached = await readManifest(directory);
  if (cached) return cached;
  await rm(directory, { recursive: true, force: true });

  await mkdir(cacheRoot, { recursive: true });
  const temporary = path.join(cacheRoot, `.mermaid-${cacheKey}-${randomUUID()}`);
  await mkdir(temporary);
  try {
    const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = await esbuild({
      absWorkingDir: moduleRoot,
      bundle: true,
      chunkNames: "chunks/[name]-[hash]",
      entryNames: "inkpath-[hash]",
      format: "esm",
      metafile: true,
      minify: true,
      outdir: temporary,
      platform: "browser",
      splitting: true,
      stdin: {
        contents: mermaidClientSource,
        loader: "js",
        resolveDir: moduleRoot,
        sourcefile: "inkpath-mermaid-client.js",
      },
      target: ["es2022"],
    });
    const entryOutput = Object.entries(result.metafile.outputs).find(
      ([, output]) => output.entryPoint === "inkpath-mermaid-client.js",
    )?.[0];
    if (!entryOutput) throw new Error("could not identify the Mermaid browser entry point");
    const entry = path.basename(entryOutput);
    const files = Object.keys(result.metafile.outputs)
      .map((output) =>
        path
          .relative(temporary, path.isAbsolute(output) ? output : path.resolve(moduleRoot, output))
          .split(path.sep)
          .join("/"),
      )
      .sort();
    if (files.some((file) => file.startsWith("../"))) {
      throw new Error("Mermaid browser assets were written outside their cache directory");
    }
    await writeFile(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify({ entry, files, inkpath: INKPATH_VERSION, mermaid: mermaidVersion }, null, 2)}\n`,
      "utf8",
    );
    try {
      await rename(temporary, directory);
    } catch (error) {
      const existing = await readManifest(directory);
      if (!existing) throw error;
      await rm(temporary, { recursive: true, force: true });
      return existing;
    }
    return { directory, entry };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function getMermaidAssets(): Promise<MermaidAssets> {
  mermaidAssetsPromise ??= createMermaidAssets().catch((error: unknown) => {
    mermaidAssetsPromise = undefined;
    throw error;
  });
  return mermaidAssetsPromise;
}

export async function copyMermaidAssets(destination: string): Promise<string> {
  const assets = await getMermaidAssets();
  await cp(assets.directory, destination, {
    filter: (source) => path.basename(source) !== "manifest.json",
    recursive: true,
  });
  return assets.entry;
}

export async function copyKatexAssets(destination: string): Promise<void> {
  const packageRoot = path.dirname(require.resolve("katex/package.json"));
  await mkdir(destination, { recursive: true });
  await cp(
    path.join(packageRoot, "dist", "katex.min.css"),
    path.join(destination, "katex.min.css"),
  );
  await cp(path.join(packageRoot, "dist", "fonts"), path.join(destination, "fonts"), {
    recursive: true,
  });
}
