import { access, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { treeIdentity, type TreeIdentity } from "./identity.js";
import {
  applyScenarioMutation,
  SCENARIO_IDS,
  scenarioForId,
  type BenchmarkMutationTargets,
  type ScenarioId,
  type ScenarioOracle,
} from "./scenarios.js";

const PROTOCOL_VERSION = 2 as const;
const RESULT_PREFIX = "@@INKPATH_BENCHMARK_RESULT@@";
const workerModuleStarted = performance.now();

export type EngineMode = "auto" | "baseline";

export type WorkerRequest = {
  buildModule: string;
  cleanAfterMutation?: boolean;
  engineMode: EngineMode;
  mutationTargets: BenchmarkMutationTargets;
  oracle: ScenarioOracle;
  outputDirectory: string;
  projectDirectory: string;
  scenario: ScenarioId;
};

export type WorkerResult = {
  build: {
    diagrams?: number;
    elapsedMs?: number;
    math?: number;
    orphans?: number;
    pages?: number;
    timings?: Record<string, number>;
  };
  changedPaths: string[];
  engine: string;
  memory: {
    arrayBuffersBytes: number;
    currentRssBytes: number;
    externalBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    maxRssBytes: number;
  };
  outputDirectory: string;
  outputManifest?: TreeIdentity;
  protocolVersion: typeof PROTOCOL_VERSION;
  resources: {
    involuntaryContextSwitches: number;
    systemCpuMs: number;
    userCpuMs: number;
    voluntaryContextSwitches: number;
  };
  scenario: ScenarioId;
  timing: {
    adapterMs: number;
    engineCallMs: number;
    initialBuildMs: number;
    moduleLoadMs: number;
    mutationMs: number;
    operationMs: number;
    requestReadMs: number;
    workerModuleToResultMs: number;
  };
};

type BuildOptions = {
  profile: true;
  write: boolean;
};

type BuildResultLike = {
  diagrams?: number;
  elapsedMs?: number;
  math?: number;
  orphans?: number;
  pages?: number;
  site?: { config?: { outputDir?: string } };
  timings?: Record<string, unknown>;
};

type BuildModule = {
  buildSite?: (projectDirectory: string, options: BuildOptions) => Promise<BuildResultLike>;
  [key: string]: unknown;
};

type IncrementalEngine = {
  build?: (options: BuildOptions) => Promise<BuildResultLike>;
  check?: (options: BuildOptions) => Promise<BuildResultLike>;
  close?: () => Promise<void> | void;
  rebuild?: (changedPaths: readonly string[], options: BuildOptions) => Promise<BuildResultLike>;
};

type BuildAdapter = {
  close(): Promise<void>;
  label: string;
  run(
    write: boolean,
    measuredRebuild: boolean,
    changedPaths?: readonly string[],
  ): Promise<BuildResultLike>;
};

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

async function readStandardInput(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isTextMutationTarget(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (isRecord(value) &&
      [
        "after",
        "before",
        "content",
        "contents",
        "path",
        "relativePath",
        "replacement",
        "search",
      ].every((field) => isOptionalString(value[field])))
  );
}

function isRenameMutationTarget(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 2 && value.every((item) => typeof item === "string");
  }
  return (
    isRecord(value) &&
    ["from", "fromRelativePath", "to", "toRelativePath"].every((field) =>
      isOptionalString(value[field]),
    )
  );
}

function isMutationTargets(value: unknown): value is BenchmarkMutationTargets {
  return (
    isRecord(value) &&
    ["addition", "body", "deletion", "link", "route", "title"].every((field) =>
      isTextMutationTarget(value[field]),
    ) &&
    isRenameMutationTarget(value.rename)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isScenarioOracle(value: unknown): value is ScenarioOracle {
  return (
    isRecord(value) &&
    typeof value.expectedPages === "number" &&
    Number.isInteger(value.expectedPages) &&
    Array.isArray(value.outputFiles) &&
    value.outputFiles.every(
      (file) =>
        isRecord(file) &&
        typeof file.exists === "boolean" &&
        typeof file.path === "string" &&
        (file.contains === undefined || isStringArray(file.contains)) &&
        (file.excludes === undefined || isStringArray(file.excludes)),
    )
  );
}

function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && SCENARIO_IDS.some((scenario) => scenario === value);
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return (
    isRecord(value) &&
    typeof value.buildModule === "string" &&
    (value.cleanAfterMutation === undefined || typeof value.cleanAfterMutation === "boolean") &&
    (value.engineMode === "auto" || value.engineMode === "baseline") &&
    isMutationTargets(value.mutationTargets) &&
    isScenarioOracle(value.oracle) &&
    typeof value.outputDirectory === "string" &&
    typeof value.projectDirectory === "string" &&
    isScenarioId(value.scenario)
  );
}

function parseRequest(value: string): WorkerRequest {
  const parsed: unknown = JSON.parse(value);
  if (!isWorkerRequest(parsed)) throw new Error("invalid benchmark worker request");
  return parsed;
}

function numericTimings(
  value: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

async function incrementalAdapter(
  module: BuildModule,
  projectDirectory: string,
): Promise<BuildAdapter | undefined> {
  for (const factoryName of ["createIncrementalBuildEngine", "createBuildEngine"] as const) {
    const candidate = module[factoryName];
    if (typeof candidate !== "function") continue;
    const engine = (await candidate(projectDirectory)) as IncrementalEngine;
    const build = engine.build;
    if (typeof build !== "function") {
      throw new Error(`${factoryName}() returned an engine without build()`);
    }
    const rebuild = engine.rebuild;
    if (typeof rebuild !== "function") {
      throw new Error(
        `${factoryName}() must implement rebuild(changedPaths, options) for benchmark protocol ${PROTOCOL_VERSION}`,
      );
    }
    return {
      async close() {
        await engine.close?.();
      },
      label: factoryName,
      async run(write, measuredRebuild, changedPaths = []) {
        const options: BuildOptions = { profile: true, write };
        if (!write && typeof engine.check === "function") return engine.check(options);
        if (measuredRebuild) return rebuild.call(engine, changedPaths, options);
        return build.call(engine, options);
      },
    };
  }
  return undefined;
}

async function createAdapter(
  module: BuildModule,
  projectDirectory: string,
  engineMode: EngineMode,
): Promise<BuildAdapter> {
  if (engineMode === "auto") {
    const incremental = await incrementalAdapter(module, projectDirectory);
    if (incremental) return incremental;
  }

  if (typeof module.buildSite !== "function") {
    throw new Error("benchmark build module does not export buildSite()");
  }
  return {
    async close() {},
    label: "buildSite",
    run(write) {
      return module.buildSite?.(projectDirectory, {
        profile: true,
        write,
      }) as Promise<BuildResultLike>;
    },
  };
}

function safeOutputPath(outputDirectory: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`benchmark oracle has an unsafe output path: ${relativePath}`);
  }
  return path.join(outputDirectory, relativePath);
}

async function validateScenarioResult(
  result: BuildResultLike,
  request: WorkerRequest,
  outputDirectory: string,
): Promise<void> {
  if (result.pages !== request.oracle.expectedPages) {
    throw new Error(
      `benchmark semantic oracle expected ${request.oracle.expectedPages} pages, received ${String(result.pages)}`,
    );
  }

  const scenario = scenarioForId(request.scenario);
  if (scenario.operation === "check") {
    if (await exists(outputDirectory)) {
      throw new Error("benchmark semantic oracle: check unexpectedly wrote an output directory");
    }
    return;
  }

  for (const file of request.oracle.outputFiles) {
    const absolutePath = safeOutputPath(outputDirectory, file.path);
    const present = await exists(absolutePath);
    if (present !== file.exists) {
      throw new Error(
        `benchmark semantic oracle expected ${file.path} to be ${file.exists ? "present" : "absent"}`,
      );
    }
    if (!present) continue;
    const contents = await readFile(absolutePath, "utf8");
    for (const expected of file.contains ?? []) {
      if (!contents.includes(expected)) {
        throw new Error(
          `benchmark semantic oracle: ${file.path} is missing ${JSON.stringify(expected)}`,
        );
      }
    }
    for (const forbidden of file.excludes ?? []) {
      if (contents.includes(forbidden)) {
        throw new Error(
          `benchmark semantic oracle: ${file.path} still contains ${JSON.stringify(forbidden)}`,
        );
      }
    }
  }
}

async function outputDirectoryForResult(
  result: BuildResultLike,
  request: WorkerRequest,
): Promise<string> {
  const projectDirectory = path.resolve(request.projectDirectory);
  const realProjectDirectory = await realpath(projectDirectory);
  const canonicalProjectPath = (target: string): string => {
    const absolute = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(projectDirectory, target);
    const relative = path.relative(projectDirectory, absolute);
    return !relative.startsWith("..") && !path.isAbsolute(relative)
      ? path.resolve(realProjectDirectory, relative)
      : absolute;
  };
  const expected = canonicalProjectPath(request.outputDirectory);
  const reported = result.site?.config?.outputDir;
  if (!reported) return expected;
  const resolved = canonicalProjectPath(reported);
  if (resolved !== expected) {
    throw new Error(`build reported output ${resolved}, expected ${expected}`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const requestReadStarted = performance.now();
  const request = parseRequest(await readStandardInput());
  const requestReadMs = performance.now() - requestReadStarted;
  const scenario = scenarioForId(request.scenario);

  const moduleLoadStarted = performance.now();
  const buildModule = (await import(pathToFileURL(request.buildModule).href)) as BuildModule;
  const moduleLoadMs = performance.now() - moduleLoadStarted;

  if (
    scenario.operation === "clean" ||
    scenario.operation === "check" ||
    request.cleanAfterMutation
  ) {
    await rm(request.outputDirectory, { force: true, recursive: true });
  }
  const coldOperationStarted = performance.now();
  const adapterStarted = performance.now();
  const adapter = await createAdapter(buildModule, request.projectDirectory, request.engineMode);
  const adapterMs = performance.now() - adapterStarted;
  let initialBuildMs = 0;
  let mutationMs = 0;
  let changedPaths: string[] = [];

  try {
    if (scenario.operation === "rebuild") {
      if (!request.cleanAfterMutation) {
        const initialBuildStarted = performance.now();
        await adapter.run(true, false);
        initialBuildMs = performance.now() - initialBuildStarted;
      }
      if (scenario.mutation) {
        const mutationStarted = performance.now();
        const mutation = await applyScenarioMutation(
          request.projectDirectory,
          request.mutationTargets,
          scenario.mutation,
        );
        mutationMs = performance.now() - mutationStarted;
        changedPaths = mutation.changedPaths;
      }
    }

    const engineCallStarted = performance.now();
    const result = await adapter.run(
      scenario.operation !== "check",
      scenario.operation === "rebuild" && !request.cleanAfterMutation,
      changedPaths,
    );
    const engineCallMs = performance.now() - engineCallStarted;
    const operationMs =
      scenario.operation === "rebuild" ? engineCallMs : performance.now() - coldOperationStarted;
    const memory = process.memoryUsage();
    const resources = process.resourceUsage();
    const outputDirectory = await outputDirectoryForResult(result, request);

    await validateScenarioResult(result, request, outputDirectory);
    const outputManifest: TreeIdentity | undefined =
      scenario.operation === "check" ? undefined : await treeIdentity(outputDirectory);
    const timings = numericTimings(result.timings);

    const response: WorkerResult = {
      protocolVersion: PROTOCOL_VERSION,
      scenario: scenario.id,
      engine: adapter.label,
      changedPaths,
      timing: {
        adapterMs,
        engineCallMs,
        initialBuildMs,
        moduleLoadMs,
        mutationMs,
        operationMs,
        requestReadMs,
        workerModuleToResultMs: performance.now() - workerModuleStarted,
      },
      build: {
        ...(typeof result.diagrams === "number" ? { diagrams: result.diagrams } : {}),
        ...(typeof result.elapsedMs === "number" ? { elapsedMs: result.elapsedMs } : {}),
        ...(typeof result.math === "number" ? { math: result.math } : {}),
        ...(typeof result.orphans === "number" ? { orphans: result.orphans } : {}),
        ...(typeof result.pages === "number" ? { pages: result.pages } : {}),
        ...(timings ? { timings } : {}),
      },
      memory: {
        arrayBuffersBytes: memory.arrayBuffers,
        currentRssBytes: memory.rss,
        externalBytes: memory.external,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        maxRssBytes: resources.maxRSS * 1024,
      },
      resources: {
        involuntaryContextSwitches: resources.involuntaryContextSwitches,
        systemCpuMs: resources.systemCPUTime / 1000,
        userCpuMs: resources.userCPUTime / 1000,
        voluntaryContextSwitches: resources.voluntaryContextSwitches,
      },
      outputDirectory,
      ...(outputManifest ? { outputManifest } : {}),
    };

    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(response)}\n`);
  } finally {
    await adapter.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
