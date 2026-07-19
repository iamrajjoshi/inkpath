import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { contributingPackageRoots, renderThirdPartyNotices } from "./notices.js";
import { mermaidClientSource } from "./theme.js";

export type MermaidAssets = {
  directory: string;
  entry: string;
};

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const thirdPartyNoticesName = "THIRD_PARTY_NOTICES.txt";
let mermaidAssetsPromise: Promise<MermaidAssets> | undefined;

async function assetCacheIdentity(directory: string, files: string[]): Promise<string> {
  const identity = createHash("sha256");
  for (const file of files) {
    identity
      .update(file)
      .update("\0")
      .update(await readFile(path.join(directory, file)));
  }
  identity
    .update(thirdPartyNoticesName)
    .update("\0")
    .update(await readFile(path.join(directory, thirdPartyNoticesName)));
  return identity.digest("hex");
}

async function readManifest(directory: string): Promise<MermaidAssets | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      entry?: unknown;
      files?: unknown;
      identity?: unknown;
      notice?: unknown;
    };
    if (
      typeof parsed.entry !== "string" ||
      !/^inkpath-[A-Z0-9]+\.js$/.test(parsed.entry) ||
      typeof parsed.identity !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.identity) ||
      parsed.notice !== thirdPartyNoticesName ||
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
    if (path.basename(directory) !== `mermaid-${parsed.identity}`) return undefined;
    if ((await assetCacheIdentity(directory, parsed.files as string[])) !== parsed.identity) {
      return undefined;
    }
    return { directory, entry: parsed.entry };
  } catch {
    return undefined;
  }
}

async function createMermaidAssets(): Promise<MermaidAssets> {
  const cacheRoot = path.join(os.tmpdir(), "inkpath-assets");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = path.join(cacheRoot, `.mermaid-${randomUUID()}`);
  await mkdir(temporary);
  try {
    const result = await esbuild({
      absWorkingDir: packageRoot,
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
        resolveDir: packageRoot,
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
          .relative(temporary, path.isAbsolute(output) ? output : path.resolve(packageRoot, output))
          .split(path.sep)
          .join("/"),
      )
      .sort();
    if (files.some((file) => file.startsWith("../"))) {
      throw new Error("Mermaid browser assets were written outside their cache directory");
    }
    const packageRoots = await contributingPackageRoots(result.metafile, packageRoot);
    const notices = await renderThirdPartyNotices(packageRoots);
    await writeFile(path.join(temporary, thirdPartyNoticesName), notices, "utf8");

    const identity = await assetCacheIdentity(temporary, files);
    const directory = path.join(cacheRoot, `mermaid-${identity}`);
    await writeFile(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify({ entry, files, identity, notice: thirdPartyNoticesName }, null, 2)}\n`,
      "utf8",
    );
    const cached = await readManifest(directory);
    if (cached) {
      await rm(temporary, { recursive: true, force: true });
      return cached;
    }
    try {
      await rename(temporary, directory);
    } catch (error) {
      const existing = await readManifest(directory);
      if (existing) {
        await rm(temporary, { recursive: true, force: true });
        return existing;
      }

      const invalid = `${directory}.invalid-${randomUUID()}`;
      try {
        await rename(directory, invalid);
      } catch {
        // Another process may have removed or replaced the same invalid cache entry.
      }
      try {
        await rename(temporary, directory);
      } catch {
        const concurrent = await readManifest(directory);
        if (!concurrent) throw error;
        await rm(temporary, { recursive: true, force: true });
        return concurrent;
      } finally {
        await rm(invalid, { recursive: true, force: true });
      }
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
  await cp(path.join(packageRoot, "LICENSE"), path.join(destination, "LICENSE.txt"));
}
