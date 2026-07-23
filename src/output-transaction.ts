import { lstat, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mapConcurrentOrdered } from "./concurrency.js";

export type OutputFileChange =
  | {
      readonly contents: string | Uint8Array;
      readonly relativePath: string;
    }
  | {
      readonly contents?: undefined;
      readonly relativePath: string;
    };

type PreparedChange = {
  contents: string | Uint8Array | undefined;
  relativePath: string;
  segments: string[];
};

type JournalEntry = PreparedChange & {
  backedUp: boolean;
  installed: boolean;
};

const SCRATCH_MARKER = ".inkpath-transaction-";

function comparePaths(left: PreparedChange, right: PreparedChange): number {
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0;
}

function isFileSystemError(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT", "ENOTDIR")) return undefined;
    throw error;
  }
}

function prepareChanges(changes: readonly OutputFileChange[]): PreparedChange[] {
  const prepared = changes.map((change, index) => {
    const candidate = change as unknown as { contents?: unknown; relativePath?: unknown };
    if (!candidate || typeof candidate !== "object" || typeof candidate.relativePath !== "string") {
      throw new TypeError(`output change ${index} must have a relativePath`);
    }
    if (
      candidate.contents !== undefined &&
      typeof candidate.contents !== "string" &&
      !(candidate.contents instanceof Uint8Array)
    ) {
      throw new TypeError(`output change ${candidate.relativePath} contents must be text or bytes`);
    }

    const relativePath = candidate.relativePath;
    if (!relativePath) throw new Error("output paths must not be empty");
    if (relativePath.includes("\0")) {
      throw new Error(`output path contains a null byte: ${relativePath}`);
    }
    if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
      throw new Error(`output path must be relative: ${relativePath}`);
    }
    if (relativePath.includes("\\")) {
      throw new Error(`output path must use forward slashes: ${relativePath}`);
    }

    const segments = relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`output path must not contain empty or dot segments: ${relativePath}`);
    }
    if (segments.some((segment) => segment.includes(SCRATCH_MARKER))) {
      throw new Error(
        `output path must not reference Inkpath scratch directories: ${relativePath}`,
      );
    }

    return {
      contents: candidate.contents as string | Uint8Array | undefined,
      relativePath,
      segments,
    };
  });

  prepared.sort(comparePaths);
  const paths = new Set(prepared.map((change) => change.relativePath));
  if (paths.size !== prepared.length) {
    for (let index = 1; index < prepared.length; index += 1) {
      if (prepared[index - 1]?.relativePath === prepared[index]?.relativePath) {
        throw new Error(`duplicate output path: ${prepared[index]?.relativePath}`);
      }
    }
  }

  for (const change of prepared) {
    let ancestor = "";
    for (const segment of change.segments.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${segment}` : segment;
      if (paths.has(ancestor)) {
        throw new Error(
          `output paths conflict because ${ancestor} is an ancestor of ${change.relativePath}`,
        );
      }
    }
  }
  return prepared;
}

async function assertSafeOutputRoot(outputRoot: string): Promise<void> {
  const info = await lstatIfPresent(outputRoot);
  if (!info) return;
  if (info.isSymbolicLink())
    throw new Error(`output root must not be a symbolic link: ${outputRoot}`);
  if (!info.isDirectory()) throw new Error(`output root must be a directory: ${outputRoot}`);
}

async function assertNoSymbolicLinks(outputRoot: string, change: PreparedChange): Promise<void> {
  await assertSafeOutputRoot(outputRoot);
  let current = outputRoot;
  for (let index = 0; index < change.segments.length; index += 1) {
    current = path.join(current, change.segments[index] as string);
    const info = await lstatIfPresent(current);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new Error(`output target must not contain symbolic links: ${change.relativePath}`);
    }
    if (index < change.segments.length - 1 && !info.isDirectory()) {
      // Leave regular-file ancestor errors to the ordered commit. This can only
      // fail closed: mkdir will not traverse it.
      return;
    }
    if (index === change.segments.length - 1 && !info.isFile()) {
      throw new Error(`output target must be a regular file: ${change.relativePath}`);
    }
  }
}

async function ensureDirectory(
  outputRoot: string,
  segments: readonly string[],
  createdDirectories: string[],
): Promise<void> {
  let current = outputRoot;
  const allSegments = ["", ...segments];
  for (const segment of allSegments) {
    if (segment) current = path.join(current, segment);
    let info = await lstatIfPresent(current);
    if (!info) {
      try {
        await mkdir(current);
        createdDirectories.push(current);
        continue;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        info = await lstatIfPresent(current);
      }
    }
    if (info?.isSymbolicLink()) {
      throw new Error(`output directory must not be a symbolic link: ${current}`);
    }
    if (!info?.isDirectory())
      throw new Error(`output path ancestor is not a directory: ${current}`);
  }
}

async function rollback(
  outputRoot: string,
  scratchRoot: string,
  journal: readonly JournalEntry[],
  createdDirectories: readonly string[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const entry of [...journal].reverse()) {
    const target = path.join(outputRoot, ...entry.segments);
    const backup = path.join(scratchRoot, "backups", ...entry.segments);
    try {
      if (entry.installed) {
        const discarded = path.join(scratchRoot, "rollback", ...entry.segments);
        await mkdir(path.dirname(discarded), { recursive: true });
        await rename(target, discarded);
      }
      if (entry.backedUp) {
        await rename(backup, target);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT", "ENOTEMPTY", "EEXIST")) errors.push(error);
    }
  }
  return errors;
}

/**
 * Atomically replaces or removes individual files under an existing output tree.
 * Replacement payloads are staged before any published file is changed. If the
 * ordered commit fails, every changed target is restored from its journaled backup.
 */
export async function replaceOutputFiles(
  outputRoot: string,
  changes: readonly OutputFileChange[],
): Promise<void> {
  const prepared = prepareChanges(changes);
  if (!prepared.length) return;

  const absoluteOutputRoot = path.resolve(outputRoot);
  const outputParent = path.dirname(absoluteOutputRoot);
  if (outputParent === absoluteOutputRoot) {
    throw new Error("output root must not be a filesystem root");
  }
  await mkdir(outputParent, { recursive: true });
  await assertSafeOutputRoot(absoluteOutputRoot);
  for (const change of prepared) await assertNoSymbolicLinks(absoluteOutputRoot, change);

  const outputName = path.basename(absoluteOutputRoot);
  const scratchRoot = await mkdtemp(path.join(outputParent, `.${outputName}${SCRATCH_MARKER}`));
  let failed = false;
  let failure: unknown;

  try {
    await mapConcurrentOrdered(prepared, async (change) => {
      if (change.contents === undefined) return;
      const staged = path.join(scratchRoot, "staged", ...change.segments);
      await mkdir(path.dirname(staged), { recursive: true });
      try {
        await writeFile(
          staged,
          change.contents,
          typeof change.contents === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" },
        );
      } catch (error) {
        throw new Error(`failed to stage output file ${change.relativePath}`, { cause: error });
      }
    });

    // Recheck after asynchronous staging so an intervening symlink cannot be
    // followed by the commit path.
    for (const change of prepared) await assertNoSymbolicLinks(absoluteOutputRoot, change);

    const journal: JournalEntry[] = [];
    const createdDirectories: string[] = [];
    try {
      for (const change of prepared) {
        const entry: JournalEntry = { ...change, backedUp: false, installed: false };
        journal.push(entry);
        const target = path.join(absoluteOutputRoot, ...change.segments);
        try {
          if (change.contents !== undefined) {
            await ensureDirectory(
              absoluteOutputRoot,
              change.segments.slice(0, -1),
              createdDirectories,
            );
          }
          await assertNoSymbolicLinks(absoluteOutputRoot, change);

          const existing = await lstatIfPresent(target);
          if (existing?.isSymbolicLink()) {
            throw new Error(`output target must not be a symbolic link: ${change.relativePath}`);
          }
          if (existing && !existing.isFile()) {
            throw new Error(`output target must be a regular file: ${change.relativePath}`);
          }
          if (existing) {
            const backup = path.join(scratchRoot, "backups", ...change.segments);
            await mkdir(path.dirname(backup), { recursive: true });
            await rename(target, backup);
            entry.backedUp = true;
          }

          if (change.contents !== undefined) {
            const staged = path.join(scratchRoot, "staged", ...change.segments);
            await rename(staged, target);
            entry.installed = true;
          }
        } catch (error) {
          throw new Error(`failed to update output file ${change.relativePath}`, { cause: error });
        }
      }
    } catch (error) {
      const rollbackErrors = await rollback(
        absoluteOutputRoot,
        scratchRoot,
        journal,
        createdDirectories,
      );
      if (rollbackErrors.length) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "output transaction failed and rollback was incomplete",
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await rm(scratchRoot, { force: true, recursive: true });
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError([failure, cleanupError], "output transaction and cleanup failed", {
        cause: failure,
      });
    }
    // Every target is already committed. Reporting failure here would make the
    // caller roll back its in-memory graph even though published bytes are new.
    // A hidden sibling scratch directory is safer than cache/output divergence.
  }
  if (failed) throw failure;
}
