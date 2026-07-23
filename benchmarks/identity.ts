import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type FileIdentity = {
  bytes: number;
  path: string;
  sha256: string;
};

export type TreeIdentity = {
  bytes: number;
  files: number;
  sha256: string;
};

export type GitIdentity = {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  dirtyPaths: string[];
};

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareNames(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

export async function treeIdentity(root: string): Promise<TreeIdentity> {
  const identity = createHash("sha256");
  let bytes = 0;
  let files = 0;

  const visit = async (directory: string): Promise<void> => {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    for (const entry of directoryEntries.sort((left, right) =>
      compareNames(left.name, right.name),
    )) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const contents = await readFile(absolutePath);
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        bytes += contents.byteLength;
        files += 1;
        identity.update(relativePath).update("\0").update(String(contents.byteLength)).update("\0");
        identity.update(sha256(contents)).update("\n");
      } else {
        throw new Error(`identity trees may contain only regular files: ${absolutePath}`);
      }
    }
  };

  await visit(root);
  return { bytes, files, sha256: identity.digest("hex") };
}

async function gitOutput(root: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? output.trimEnd() : undefined));
  });
}

/** Capture the source revision and the exact paths that make it non-reproducible. */
export async function gitIdentity(root: string): Promise<GitIdentity> {
  const [commit, branch, status] = await Promise.all([
    gitOutput(root, ["rev-parse", "HEAD"]),
    gitOutput(root, ["branch", "--show-current"]),
    gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const dirtyPaths = status
    ? status
        .split(/\r?\n/)
        .filter(Boolean)
        .map((entry) => entry.slice(3))
    : [];
  return {
    branch: branch || null,
    commit: commit ?? null,
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
}
