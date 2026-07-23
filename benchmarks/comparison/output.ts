import { createHash, type Hash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { sha256 } from "../identity.js";
import type { ComparisonExpectedPage } from "./corpus.js";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const OUTPUT_COMPRESSION_CACHE_LIMIT = 64;
const OUTPUT_COMPRESSION_CONCURRENCY = 8;

export type OutputCategory = "css" | "html" | "javascript" | "other";

const OUTPUT_CATEGORIES: readonly OutputCategory[] = ["css", "html", "javascript", "other"];

export type ByteCounts = {
  brotliBytes: number;
  files: number;
  gzipBytes: number;
  rawBytes: number;
};

export type OutputSummary = {
  byCategory: Record<OutputCategory, ByteCounts>;
  files: number;
  sha256: string;
};

export type OutputSummaryCacheStats = {
  entries: number;
  hits: number;
  misses: number;
};

export type SemanticPageValidation = {
  anchors: number;
  assets: number;
  codeBlocks: number;
  links: number;
  pages: number;
};

type OutputFile = {
  absolutePath: string;
  relativePath: string;
};

type ReadOutputFile = OutputFile & {
  category: OutputCategory;
  contents: Buffer;
};

type CompressedOutputFile = ReadOutputFile & {
  brotliBytes: number;
  gzipBytes: number;
};

type CachedCompression = Record<OutputCategory, Pick<ByteCounts, "brotliBytes" | "gzipBytes">>;

const outputCompressionCache = new Map<string, CachedCompression>();
let outputCompressionCacheHits = 0;
let outputCompressionCacheMisses = 0;

function emptyCounts(): ByteCounts {
  return { brotliBytes: 0, files: 0, gzipBytes: 0, rawBytes: 0 };
}

function emptyCategoryCounts(): Record<OutputCategory, ByteCounts> {
  return {
    css: emptyCounts(),
    html: emptyCounts(),
    javascript: emptyCounts(),
    other: emptyCounts(),
  };
}

function categoryFor(relativePath: string): OutputCategory {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".css") return "css";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }
  return "other";
}

async function outputFiles(root: string): Promise<OutputFile[]> {
  const files: OutputFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`generated output may not contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
        });
      }
    }
  };
  await visit(root);
  return files;
}

async function processOutputFiles<T>(
  files: readonly OutputFile[],
  process: (file: OutputFile) => Promise<T>,
  consume: (result: T) => void,
): Promise<void> {
  for (let start = 0; start < files.length; start += OUTPUT_COMPRESSION_CONCURRENCY) {
    const batch = await Promise.all(
      files.slice(start, start + OUTPUT_COMPRESSION_CONCURRENCY).map(process),
    );
    for (const result of batch) consume(result);
  }
}

async function readOutputFile(file: OutputFile): Promise<ReadOutputFile> {
  return {
    ...file,
    category: categoryFor(file.relativePath),
    contents: await readFile(file.absolutePath),
  };
}

async function compressOutputFile(file: OutputFile): Promise<CompressedOutputFile> {
  const read = await readOutputFile(file);
  const [gzipContents, brotliContents] = await Promise.all([
    gzipAsync(read.contents, { level: 9 }),
    brotliCompressAsync(read.contents, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]:
          read.category === "other"
            ? zlibConstants.BROTLI_MODE_GENERIC
            : zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
  ]);
  return {
    ...read,
    brotliBytes: brotliContents.byteLength,
    gzipBytes: gzipContents.byteLength,
  };
}

function updateOutputHash(hash: Hash, file: ReadOutputFile): void {
  const name = Buffer.from(file.relativePath);
  const nameLength = Buffer.allocUnsafe(4);
  nameLength.writeUInt32BE(name.byteLength);
  const contentsLength = Buffer.allocUnsafe(8);
  contentsLength.writeBigUInt64BE(BigInt(file.contents.byteLength));
  hash.update(nameLength).update(name).update(contentsLength).update(file.contents);
}

function addRawCounts(byCategory: Record<OutputCategory, ByteCounts>, file: ReadOutputFile): void {
  const counts = byCategory[file.category];
  counts.files += 1;
  counts.rawBytes += file.contents.byteLength;
}

async function identifyOutput(files: readonly OutputFile[]): Promise<OutputSummary> {
  const byCategory = emptyCategoryCounts();
  const hash = createHash("sha256");
  await processOutputFiles(files, readOutputFile, (file) => {
    addRawCounts(byCategory, file);
    updateOutputHash(hash, file);
  });
  return { byCategory, files: files.length, sha256: hash.digest("hex") };
}

async function compressAndSummarizeOutput(files: readonly OutputFile[]): Promise<OutputSummary> {
  const byCategory = emptyCategoryCounts();
  const hash = createHash("sha256");
  await processOutputFiles(files, compressOutputFile, (file) => {
    addRawCounts(byCategory, file);
    const counts = byCategory[file.category];
    counts.gzipBytes += file.gzipBytes;
    counts.brotliBytes += file.brotliBytes;
    updateOutputHash(hash, file);
  });
  return { byCategory, files: files.length, sha256: hash.digest("hex") };
}

function outputIdentityKey(summary: OutputSummary): string {
  return [
    summary.sha256,
    summary.files,
    ...OUTPUT_CATEGORIES.flatMap((category) => [
      summary.byCategory[category].files,
      summary.byCategory[category].rawBytes,
    ]),
  ].join(":");
}

function cachedCompression(summary: OutputSummary): CachedCompression {
  return {
    css: {
      brotliBytes: summary.byCategory.css.brotliBytes,
      gzipBytes: summary.byCategory.css.gzipBytes,
    },
    html: {
      brotliBytes: summary.byCategory.html.brotliBytes,
      gzipBytes: summary.byCategory.html.gzipBytes,
    },
    javascript: {
      brotliBytes: summary.byCategory.javascript.brotliBytes,
      gzipBytes: summary.byCategory.javascript.gzipBytes,
    },
    other: {
      brotliBytes: summary.byCategory.other.brotliBytes,
      gzipBytes: summary.byCategory.other.gzipBytes,
    },
  };
}

function withCachedCompression(
  identity: OutputSummary,
  compression: CachedCompression,
): OutputSummary {
  const byCategory = emptyCategoryCounts();
  for (const category of OUTPUT_CATEGORIES) {
    byCategory[category] = {
      ...identity.byCategory[category],
      ...compression[category],
    };
  }
  return { byCategory, files: identity.files, sha256: identity.sha256 };
}

function rememberCompression(key: string, summary: OutputSummary): void {
  if (outputCompressionCache.size >= OUTPUT_COMPRESSION_CACHE_LIMIT) {
    const oldestKey = outputCompressionCache.keys().next().value;
    if (oldestKey !== undefined) outputCompressionCache.delete(oldestKey);
  }
  outputCompressionCache.set(key, cachedCompression(summary));
}

export function resetOutputSummaryCacheForTests(): void {
  outputCompressionCache.clear();
  outputCompressionCacheHits = 0;
  outputCompressionCacheMisses = 0;
}

export function outputSummaryCacheStatsForTests(): OutputSummaryCacheStats {
  return {
    entries: outputCompressionCache.size,
    hits: outputCompressionCacheHits,
    misses: outputCompressionCacheMisses,
  };
}

/** Count compressed bytes per response/file after the timed build has ended. */
export async function summarizeOutput(root: string): Promise<OutputSummary> {
  const identity = await identifyOutput(await outputFiles(root));
  const key = outputIdentityKey(identity);
  const cached = outputCompressionCache.get(key);
  if (cached) {
    outputCompressionCacheHits += 1;
    outputCompressionCache.delete(key);
    outputCompressionCache.set(key, cached);
    return withCachedCompression(identity, cached);
  }

  outputCompressionCacheMisses += 1;
  const summary = await compressAndSummarizeOutput(await outputFiles(root));
  if (outputIdentityKey(summary) !== key) {
    throw new Error("generated output changed while it was being summarized");
  }
  rememberCompression(key, summary);
  return summary;
}

function htmlBody(html: string, outputPath: string): string {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (!match?.[1]) throw new Error(`generated page has no HTML body: ${outputPath}`);
  return match[1];
}

function anchorHrefs(body: string): string[] {
  return [...body.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)].flatMap((match) =>
    match[2] ? [match[2].replaceAll("&amp;", "&")] : [],
  );
}

function normalizedRoute(route: string): string {
  let normalized = decodeURIComponent(route).replaceAll(/\/{2,}/g, "/");
  normalized = normalized.replace(/\/index\.html$/i, "/").replace(/\.html$/i, "");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

function markerCount(contents: string, marker: string): number {
  return contents.split(marker).length - 1;
}

/** Validate each logical page at its exact native output route after timing. */
export async function validateSemanticPages(
  root: string,
  pages: readonly ComparisonExpectedPage[],
  mutation: {
    expectedMarker: string;
    forbiddenMarker: string;
    sourcePath: string;
  },
): Promise<SemanticPageValidation> {
  const files = await outputFiles(root);
  const outputPaths = new Set(files.map((file) => file.relativePath));
  const outputByPath = new Map(files.map((file) => [file.relativePath, file] as const));
  let anchors = 0;
  let assets = 0;
  let codeBlocks = 0;
  let links = 0;

  for (const page of pages) {
    if (!outputPaths.has(page.outputPath)) {
      throw new Error(`generated output is missing expected route file: ${page.outputPath}`);
    }
    const html = await readFile(path.join(root, ...page.outputPath.split("/")), "utf8");
    const body = htmlBody(html, page.outputPath);
    if (markerCount(body, page.marker) !== 1) {
      throw new Error(
        `generated page must contain its body marker exactly once: ${page.outputPath} (${page.marker})`,
      );
    }
    if (!/<[^>]+\bid\s*=\s*(["'])details\1/i.test(body)) {
      throw new Error(`generated page is missing its #details anchor: ${page.outputPath}`);
    }
    anchors += 1;

    const hrefs = anchorHrefs(body);
    const linkedRoutes = new Set<string>();
    const base = new URL(page.route, "https://comparison.example");
    for (const href of hrefs) {
      try {
        const target = new URL(href, base);
        if (target.origin === base.origin && target.hash === "#details") {
          linkedRoutes.add(normalizedRoute(target.pathname));
        }
      } catch {
        // An unrelated malformed href cannot satisfy a required fixture link.
      }
    }
    for (const targetRoute of page.linkTargetRoutes) {
      if (!linkedRoutes.has(normalizedRoute(targetRoute))) {
        throw new Error(
          `generated page is missing resolved link to ${targetRoute}#details: ${page.outputPath}`,
        );
      }
      links += 1;
    }

    if (page.assetFileName) {
      if (!page.assetSha256) {
        throw new Error(
          `comparison page is missing its expected asset identity: ${page.outputPath}`,
        );
      }
      const extension = path.posix.extname(page.assetFileName);
      const stem = page.assetFileName.slice(0, -extension.length);
      const assetHrefs = hrefs.filter((href) => href.includes(stem));
      if (!assetHrefs.length) {
        throw new Error(`generated page is missing its local asset link: ${page.outputPath}`);
      }
      let malformed = false;
      let external = false;
      const missingPaths: string[] = [];
      const mismatchedPaths: string[] = [];
      let matched = false;
      for (const assetHref of assetHrefs) {
        let assetUrl: URL;
        let linkedAssetPath: string;
        try {
          assetUrl = new URL(assetHref, base);
          linkedAssetPath = decodeURIComponent(assetUrl.pathname).replace(/^\/+/, "");
        } catch {
          malformed = true;
          continue;
        }
        if (assetUrl.origin !== base.origin) {
          external = true;
          continue;
        }
        const linkedAsset = outputByPath.get(linkedAssetPath);
        if (!linkedAsset) {
          missingPaths.push(linkedAssetPath);
          continue;
        }
        if (sha256(await readFile(linkedAsset.absolutePath)) !== page.assetSha256) {
          mismatchedPaths.push(linkedAssetPath);
          continue;
        }
        matched = true;
        break;
      }
      if (!matched) {
        if (mismatchedPaths.length) {
          throw new Error(`generated page is missing its expected local asset: ${page.outputPath}`);
        }
        if (missingPaths.length) {
          throw new Error(`generated output is missing linked local asset at ${missingPaths[0]}`);
        }
        if (external) {
          throw new Error(
            `generated page rewrote a local asset to another origin: ${page.outputPath}`,
          );
        }
        if (malformed) {
          throw new Error(`generated page has a malformed local asset URL: ${page.outputPath}`);
        }
        throw new Error(`generated page is missing its expected local asset: ${page.outputPath}`);
      }
      assets += 1;
    }

    if (page.typescript) {
      if (!body.includes("comparisonValue") || !/<code\b/i.test(body)) {
        throw new Error(`generated page is missing its TypeScript code block: ${page.outputPath}`);
      }
      codeBlocks += 1;
    }

    if (page.sourcePath === mutation.sourcePath) {
      if (markerCount(body, mutation.expectedMarker) !== 1) {
        throw new Error(
          `generated mutation page must contain ${mutation.expectedMarker} exactly once: ${page.outputPath}`,
        );
      }
      if (body.includes(mutation.forbiddenMarker)) {
        throw new Error(
          `generated mutation page retained forbidden marker ${mutation.forbiddenMarker}: ${page.outputPath}`,
        );
      }
    }
  }

  return { anchors, assets, codeBlocks, links, pages: pages.length };
}
