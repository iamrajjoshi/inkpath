import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCENARIO_IDS = [
  "check",
  "clean-build",
  "no-op-rebuild",
  "body-edit",
  "title-edit",
  "route-edit",
  "link-edit",
  "file-add",
  "file-delete",
  "file-rename",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
type ScenarioOperation = "check" | "clean" | "rebuild";
type MutationKind = "body" | "title" | "route" | "link" | "addition" | "deletion" | "rename";

type ScenarioDefinition = {
  id: ScenarioId;
  label: string;
  mutation?: MutationKind;
  operation: ScenarioOperation;
};

const SCENARIOS: readonly ScenarioDefinition[] = [
  { id: "check", label: "Check", operation: "check" },
  { id: "clean-build", label: "Clean production build", operation: "clean" },
  { id: "no-op-rebuild", label: "No-op rebuild", operation: "rebuild" },
  { id: "body-edit", label: "Single-page body edit", mutation: "body", operation: "rebuild" },
  { id: "title-edit", label: "Title edit", mutation: "title", operation: "rebuild" },
  { id: "route-edit", label: "Route edit", mutation: "route", operation: "rebuild" },
  {
    id: "link-edit",
    label: "Link and backlink edit",
    mutation: "link",
    operation: "rebuild",
  },
  { id: "file-add", label: "File addition", mutation: "addition", operation: "rebuild" },
  { id: "file-delete", label: "File deletion", mutation: "deletion", operation: "rebuild" },
  { id: "file-rename", label: "File rename", mutation: "rename", operation: "rebuild" },
];

type TextMutationTarget =
  | string
  | {
      after?: string;
      before?: string;
      content?: string;
      contents?: string;
      path?: string;
      relativePath?: string;
      replacement?: string;
      search?: string;
    };

type RenameMutationTarget =
  | {
      from?: string;
      fromRelativePath?: string;
      to?: string;
      toRelativePath?: string;
    }
  | readonly [string, string];

export type BenchmarkMutationTargets = {
  addition: TextMutationTarget;
  body: TextMutationTarget;
  deletion: TextMutationTarget;
  link: TextMutationTarget;
  rename: RenameMutationTarget;
  route: TextMutationTarget;
  title: TextMutationTarget;
};

type MutationResult = {
  changedPaths: string[];
};

type OutputFileOracle = {
  contains?: string[];
  excludes?: string[];
  exists: boolean;
  path: string;
};

export type ScenarioOracle = {
  expectedPages: number;
  outputFiles: OutputFileOracle[];
};

export type ScenarioOracles = Record<ScenarioId, ScenarioOracle>;

const scenarioById = new Map<string, ScenarioDefinition>(
  SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

export function scenarioForId(id: string): ScenarioDefinition {
  const scenario = scenarioById.get(id);
  if (!scenario) {
    throw new Error(`unknown scenario ${JSON.stringify(id)}; choose ${SCENARIO_IDS.join(", ")}`);
  }
  return scenario;
}

function targetPath(target: TextMutationTarget, label: string): string {
  const relativePath =
    typeof target === "string" ? target : (target.relativePath ?? target.path ?? undefined);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${label} mutation needs a safe project-relative path`);
  }
  return relativePath;
}

function descriptorReplacement(
  target: TextMutationTarget,
): { after: string; before: string } | undefined {
  if (typeof target === "string") return undefined;
  const before = target.before ?? target.search;
  const after = target.after ?? target.replacement;
  return before !== undefined && after !== undefined ? { after, before } : undefined;
}

function replaceExactlyOnce(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label} mutation marker was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} mutation marker is not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

async function editTextTarget(
  projectRoot: string,
  target: TextMutationTarget,
  kind: "body" | "link" | "route" | "title",
): Promise<MutationResult> {
  const relativePath = targetPath(target, kind);
  const absolutePath = path.join(projectRoot, relativePath);
  const source = await readFile(absolutePath, "utf8");
  const replacement = descriptorReplacement(target);
  let updated: string;

  if (replacement) {
    updated = replaceExactlyOnce(source, replacement.before, replacement.after, kind);
  } else if (kind === "body") {
    updated = `${source.trimEnd()}\n\nBenchmark body edit marker.\n`;
  } else if (kind === "title") {
    const match = source.match(/^title:\s*(.+)$/m);
    if (!match?.[0] || !match[1]) throw new Error("title mutation target has no title field");
    updated = replaceExactlyOnce(source, match[0], `title: ${match[1]} edited`, kind);
  } else if (kind === "route") {
    const slug = source.match(/^slug:\s*(.+)$/m);
    if (slug?.[0]) {
      updated = replaceExactlyOnce(source, slug[0], "slug: benchmark-route-edited", kind);
    } else {
      const opening = source.match(/^---\r?\n/);
      if (!opening?.[0]) throw new Error("route mutation target has no frontmatter block");
      updated = source.replace(opening[0], `${opening[0]}slug: benchmark-route-edited\n`);
    }
  } else {
    const markdownLink = source.match(/\[([^\]]+)]\(([^)]+\.md(?:#[^)]+)?)\)/i);
    if (!markdownLink?.[0] || !markdownLink[1]) {
      throw new Error("link mutation target has no relative Markdown link");
    }
    updated = replaceExactlyOnce(source, markdownLink[0], markdownLink[1], kind);
  }

  await writeFile(absolutePath, updated, "utf8");
  return { changedPaths: [relativePath] };
}

async function addFile(projectRoot: string, target: TextMutationTarget): Promise<MutationResult> {
  const relativePath = targetPath(target, "addition");
  const absolutePath = path.join(projectRoot, relativePath);
  const contents =
    typeof target === "string"
      ? undefined
      : (target.content ?? target.contents ?? target.after ?? target.replacement ?? undefined);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    contents ??
      "---\ntitle: Added benchmark note\ndescription: Added during the benchmark.\n---\n\nAdded benchmark content.\n",
    { encoding: "utf8", flag: "wx" },
  );
  return { changedPaths: [relativePath] };
}

async function deleteFile(
  projectRoot: string,
  target: TextMutationTarget,
): Promise<MutationResult> {
  const relativePath = targetPath(target, "deletion");
  await rm(path.join(projectRoot, relativePath));
  return { changedPaths: [relativePath] };
}

function renamePaths(target: RenameMutationTarget): { from: string; to: string } {
  const isTuple = (value: RenameMutationTarget): value is readonly [string, string] =>
    Array.isArray(value);
  const [from, to] = isTuple(target)
    ? target
    : [target.fromRelativePath ?? target.from, target.toRelativePath ?? target.to];
  if (
    !from ||
    !to ||
    path.isAbsolute(from) ||
    path.isAbsolute(to) ||
    from.split(/[\\/]/).includes("..") ||
    to.split(/[\\/]/).includes("..")
  ) {
    throw new Error("rename mutation needs safe project-relative from and to paths");
  }
  return { from, to };
}

async function renameFile(
  projectRoot: string,
  target: RenameMutationTarget,
): Promise<MutationResult> {
  const paths = renamePaths(target);
  await mkdir(path.dirname(path.join(projectRoot, paths.to)), { recursive: true });
  await rename(path.join(projectRoot, paths.from), path.join(projectRoot, paths.to));
  return { changedPaths: [paths.from, paths.to] };
}

export async function applyScenarioMutation(
  projectRoot: string,
  targets: BenchmarkMutationTargets,
  mutation: MutationKind,
): Promise<MutationResult> {
  if (mutation === "addition") return addFile(projectRoot, targets.addition);
  if (mutation === "deletion") return deleteFile(projectRoot, targets.deletion);
  if (mutation === "rename") return renameFile(projectRoot, targets.rename);
  return editTextTarget(projectRoot, targets[mutation], mutation);
}

async function restoreFile(
  projectRoot: string,
  pristineRoot: string,
  relativePath: string,
): Promise<void> {
  const destination = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(pristineRoot, relativePath), destination);
}

/** Restore the handful of mutable fixture paths without copying the complete benchmark tree. */
export async function restoreBenchmarkProject(
  projectRoot: string,
  pristineRoot: string,
  targets: BenchmarkMutationTargets,
): Promise<void> {
  for (const [kind, target] of [
    ["body", targets.body],
    ["title", targets.title],
    ["route", targets.route],
    ["link", targets.link],
    ["deletion", targets.deletion],
  ] as const) {
    await restoreFile(projectRoot, pristineRoot, targetPath(target, kind));
  }

  await rm(path.join(projectRoot, targetPath(targets.addition, "addition")), { force: true });
  const renameTarget = renamePaths(targets.rename);
  await rm(path.join(projectRoot, renameTarget.to), { force: true });
  await restoreFile(projectRoot, pristineRoot, renameTarget.from);
}
