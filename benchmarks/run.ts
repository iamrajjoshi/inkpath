import { spawn } from "node:child_process";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateBenchmarkSite,
  type BenchmarkProfile,
  type GeneratedBenchmarkSite,
} from "./generate.js";
import { gitIdentity, treeIdentity, type TreeIdentity } from "./identity.js";
import {
  restoreBenchmarkProject,
  SCENARIO_IDS,
  scenarioForId,
  type ScenarioId,
} from "./scenarios.js";
import type { EngineMode, WorkerRequest, WorkerResult } from "./worker.js";

const RESULT_PREFIX = "@@INKPATH_BENCHMARK_RESULT@@";
const REPORT_SCHEMA_VERSION = 2;
const repositoryRoot = path.resolve(process.cwd());
const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
const buildModule = path.join(repositoryRoot, "dist", "index.js");

type RunnerOptions = {
  engineMode: EngineMode;
  jsonPath?: string;
  keepFixtures: boolean;
  large: boolean;
  linkFanout?: number;
  markdownPath?: string;
  measureOutput: boolean;
  pages: number[];
  profile: BenchmarkProfile;
  quiet: boolean;
  samples: number;
  scenarios: ScenarioId[];
  warmups: number;
};

type RawSample = WorkerResult & {
  sample: number;
  workerWallMs: number;
};

type MetricSummary = {
  median: number;
  p95: number;
};

type ByteCounts = {
  brotliBytes: number;
  files: number;
  gzipBytes: number;
  rawBytes: number;
};

type OutputCounts = {
  css: ByteCounts;
  html: ByteCounts;
  javascript: ByteCounts;
};

type FixtureMetadata = {
  linkFanout: number;
  manifestBytes: number;
  manifestFiles: number;
  manifestSha256: string;
  mutationTargetsSha256: string;
  notes: number;
  pages: number;
  profile: BenchmarkProfile;
  sections: number;
  suiteSha256: string;
};

type ScenarioResult = {
  buildElapsedMs?: MetricSummary;
  buildPhases: Record<string, MetricSummary>;
  canonicalBaselineOutputSha256?: string;
  engine: string;
  fixture: FixtureMetadata;
  memory: {
    currentRssBytes: MetricSummary;
    heapUsedBytes: MetricSummary;
    maxRssBytes: MetricSummary;
  };
  operationMs: MetricSummary;
  output?: OutputCounts;
  outputManifest?: TreeIdentity;
  rawSamples: RawSample[];
  scenario: ScenarioId;
  warmupOperationMs: number[];
  workerWallMs: MetricSummary;
};

type RepositoryMetadata = {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  dirtyFiles: string[];
  inkpathVersion: string;
};

type BenchmarkReport = {
  metadata: {
    artifact: TreeIdentity & { entry: string };
    generatedAt: string;
    git: RepositoryMetadata;
    hardware: { cpu: string; logicalCpus: number; totalMemoryBytes: number };
    options: {
      engineMode: EngineMode;
      linkFanout: number | null;
      measureOutput: boolean;
      pages: number[];
      profile: BenchmarkProfile;
      samples: number;
      scenarios: ScenarioId[];
      warmups: number;
    };
    runtime: {
      arch: string;
      node: string;
      platform: NodeJS.Platform;
      release: string;
      versions: NodeJS.ProcessVersions;
    };
  };
  results: ScenarioResult[];
  schemaVersion: number;
};

const help = `Inkpath benchmark runner

Build dist before running this command:
  pnpm build
  pnpm benchmark:compile
  node .inkpath-benchmark/runner/run.js [options]

Options:
  --pages <list>       Comma-separated exact page counts (default: 100)
  --scenarios <list>   Comma-separated scenario IDs (default: all)
  --samples <count>    Measured isolated workers per scenario (default: 3)
  --warmups <count>    Discarded isolated workers per scenario (default: 1)
  --profile <name>     Generator profile: core or rich (default: core)
  --link-fanout <n>    Internal links per generated linkable note
  --engine <mode>      auto or baseline (default: auto)
  --large              Permit fixtures with 100,000 or more pages
  --json <path|->      Write the complete JSON report
  --markdown <path|->  Write the Markdown report
  --keep-fixtures      Keep the temporary generated fixtures
  --skip-output-bytes  Skip post-timing gzip/Brotli output accounting
  --quiet              Suppress progress messages
  --help               Show this help

Scenario IDs:
  ${SCENARIO_IDS.join(", ")}
`;

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
  return value;
}

function positiveInteger(value: string, option: string, allowZero = false): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return number;
}

function commaSeparatedIntegers(value: string, option: string): number[] {
  const numbers = value.split(",").map((item) => positiveInteger(item.trim(), option));
  return [...new Set(numbers)];
}

function parseArguments(args: string[]): RunnerOptions | "help" {
  if (args.includes("--help")) return "help";
  const options: RunnerOptions = {
    engineMode: "auto",
    keepFixtures: false,
    large: false,
    measureOutput: true,
    pages: [100],
    profile: "core",
    quiet: false,
    samples: 3,
    scenarios: [...SCENARIO_IDS],
    warmups: 1,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--" && index === 0) {
      continue;
    } else if (argument === "--pages") {
      options.pages = commaSeparatedIntegers(optionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--scenarios") {
      const values = optionValue(args, index, argument)
        .split(",")
        .map((item) => item.trim());
      options.scenarios = [...new Set(values.map((value) => scenarioForId(value).id))];
      index += 1;
    } else if (argument === "--samples") {
      options.samples = positiveInteger(optionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--warmups") {
      options.warmups = positiveInteger(optionValue(args, index, argument), argument, true);
      index += 1;
    } else if (argument === "--profile") {
      const value = optionValue(args, index, argument);
      if (value !== "core" && value !== "rich") throw new Error("--profile must be core or rich");
      options.profile = value;
      index += 1;
    } else if (argument === "--link-fanout") {
      options.linkFanout = positiveInteger(optionValue(args, index, argument), argument, true);
      index += 1;
    } else if (argument === "--engine") {
      const value = optionValue(args, index, argument);
      if (value !== "auto" && value !== "baseline") {
        throw new Error("--engine must be auto or baseline");
      }
      options.engineMode = value;
      index += 1;
    } else if (argument === "--json") {
      options.jsonPath = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--markdown") {
      options.markdownPath = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--large") {
      options.large = true;
    } else if (argument === "--keep-fixtures") {
      options.keepFixtures = true;
    } else if (argument === "--skip-output-bytes") {
      options.measureOutput = false;
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.pages.length) throw new Error("--pages must include at least one page count");
  if (!options.scenarios.length) throw new Error("--scenarios must include at least one scenario");
  if (options.pages.some((pages) => pages < 20)) {
    throw new Error("benchmark fixtures require at least 20 pages");
  }
  if (!options.large && options.pages.some((pages) => pages >= 100_000)) {
    throw new Error("fixtures with 100,000 or more pages require --large");
  }
  if (options.jsonPath === "-" && options.markdownPath === "-") {
    throw new Error("JSON and Markdown cannot both be written to stdout");
  }
  return options;
}

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function nearestRankP95(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function summarize(values: readonly number[]): MetricSummary {
  return { median: median(values), p95: nearestRankP95(values) };
}

async function repositoryMetadata(): Promise<RepositoryMetadata> {
  const [git, packageMetadata] = await Promise.all([
    gitIdentity(repositoryRoot),
    readFile(path.join(repositoryRoot, "package.json"), "utf8").then((contents) => {
      const parsed: unknown = JSON.parse(contents);
      return isRecord(parsed) ? parsed : {};
    }),
  ]);
  return {
    branch: git.branch,
    commit: git.commit,
    dirty: git.dirty,
    dirtyFiles: git.dirtyPaths,
    inkpathVersion:
      typeof packageMetadata.version === "string" ? packageMetadata.version : "unknown",
  };
}

function fixtureMetadata(fixture: GeneratedBenchmarkSite): FixtureMetadata {
  return {
    linkFanout: fixture.linkFanout,
    manifestBytes: fixture.manifest.reduce((total, file) => total + file.bytes, 0),
    manifestFiles: fixture.manifest.length,
    manifestSha256: fixture.manifestSha256,
    mutationTargetsSha256: fixture.mutationTargetsSha256,
    notes: fixture.notes,
    pages: fixture.pages,
    profile: fixture.profile,
    sections: fixture.sections,
    suiteSha256: fixture.suiteSha256,
  };
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasFiniteNumbers(value: JsonObject, fields: readonly string[]): boolean {
  return fields.every((field) => isFiniteNumber(value[field]));
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isNumericRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isTreeIdentity(value: unknown): value is TreeIdentity {
  return (
    isRecord(value) &&
    isFiniteNumber(value.bytes) &&
    isFiniteNumber(value.files) &&
    typeof value.sha256 === "string"
  );
}

function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && SCENARIO_IDS.some((scenario) => scenario === value);
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (
    !isRecord(value) ||
    !isRecord(value.build) ||
    !isRecord(value.memory) ||
    !isRecord(value.resources) ||
    !isRecord(value.timing)
  ) {
    return false;
  }
  const build = value.build;
  return (
    value.protocolVersion === 2 &&
    Array.isArray(value.changedPaths) &&
    value.changedPaths.every((changedPath) => typeof changedPath === "string") &&
    typeof value.engine === "string" &&
    typeof value.outputDirectory === "string" &&
    (value.outputManifest === undefined || isTreeIdentity(value.outputManifest)) &&
    isScenarioId(value.scenario) &&
    ["diagrams", "elapsedMs", "math", "orphans", "pages"].every((field) =>
      isOptionalFiniteNumber(build[field]),
    ) &&
    (build.timings === undefined || isNumericRecord(build.timings)) &&
    hasFiniteNumbers(value.memory, [
      "arrayBuffersBytes",
      "currentRssBytes",
      "externalBytes",
      "heapTotalBytes",
      "heapUsedBytes",
      "maxRssBytes",
    ]) &&
    hasFiniteNumbers(value.resources, [
      "involuntaryContextSwitches",
      "systemCpuMs",
      "userCpuMs",
      "voluntaryContextSwitches",
    ]) &&
    hasFiniteNumbers(value.timing, [
      "adapterMs",
      "engineCallMs",
      "initialBuildMs",
      "moduleLoadMs",
      "mutationMs",
      "operationMs",
      "requestReadMs",
      "workerModuleToResultMs",
    ])
  );
}

export async function runWorker(
  request: WorkerRequest,
): Promise<WorkerResult & { workerWallMs: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {
      // The close handler below reports the worker's useful error.
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `benchmark worker failed (${signal ? `signal ${signal}` : `exit ${code}`}):\n${stderr || stdout}`,
          ),
        );
        return;
      }
      const line = stdout
        .split(/\r?\n/)
        .reverse()
        .find((candidate) => candidate.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error(`benchmark worker returned no protocol result:\n${stdout}\n${stderr}`));
        return;
      }
      try {
        const result: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
        if (!isRecord(result) || result.protocolVersion !== 2) {
          throw new Error(
            `unsupported worker protocol ${String(isRecord(result) ? result.protocolVersion : undefined)}`,
          );
        }
        if (!isWorkerResult(result)) throw new Error("invalid benchmark worker protocol result");
        resolve({ ...result, workerWallMs: performance.now() - started });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function emptyByteCounts(): ByteCounts {
  return { brotliBytes: 0, files: 0, gzipBytes: 0, rawBytes: 0 };
}

async function outputByteCounts(outputDirectory: string): Promise<OutputCounts> {
  const counts: OutputCounts = {
    css: emptyByteCounts(),
    html: emptyByteCounts(),
    javascript: emptyByteCounts(),
  };

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const category =
        extension === ".html"
          ? counts.html
          : extension === ".css"
            ? counts.css
            : extension === ".js" || extension === ".mjs"
              ? counts.javascript
              : undefined;
      if (!category) continue;
      const contents = await readFile(entryPath);
      category.files += 1;
      category.rawBytes += contents.byteLength;
      category.gzipBytes += gzipSync(contents, { level: 9 }).byteLength;
      category.brotliBytes += brotliCompressSync(contents, {
        params: {
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      }).byteLength;
    }
  };

  await visit(outputDirectory);
  return counts;
}

function aggregateBuildPhases(samples: readonly RawSample[]): Record<string, MetricSummary> {
  const phaseNames = new Set(samples.flatMap((sample) => Object.keys(sample.build.timings ?? {})));
  return Object.fromEntries(
    [...phaseNames].sort().map((phase) => [
      phase,
      summarize(
        samples.flatMap((sample) => {
          const value = sample.build.timings?.[phase];
          return typeof value === "number" ? [value] : [];
        }),
      ),
    ]),
  );
}

type ScenarioRun = {
  capturedOutput?: string;
  result: ScenarioResult;
};

async function runScenario(
  runRoot: string,
  projectDirectory: string,
  fixture: GeneratedBenchmarkSite,
  scenario: ScenarioId,
  options: RunnerOptions,
  captureOutput: boolean,
): Promise<ScenarioRun> {
  const warmupOperationMs: number[] = [];
  const rawSamples: RawSample[] = [];
  const outputHashes = new Set<string>();
  const iterations = options.warmups + options.samples;
  const outputDirectory = path.join(projectDirectory, "site");
  const writesOutput = scenarioForId(scenario).operation !== "check";

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const warmup = iteration < options.warmups;
    const sampleNumber = warmup ? iteration + 1 : iteration - options.warmups + 1;
    await restoreBenchmarkProject(projectDirectory, fixture.root, fixture.mutationTargets);
    await rm(outputDirectory, { force: true, recursive: true });
    const workerResult = await runWorker({
      buildModule,
      engineMode: options.engineMode,
      mutationTargets: fixture.mutationTargets,
      oracle: fixture.scenarioOracles[scenario],
      outputDirectory,
      projectDirectory,
      scenario,
    });
    if (workerResult.scenario !== scenario) {
      throw new Error(`worker returned scenario ${workerResult.scenario}, expected ${scenario}`);
    }
    if (writesOutput && !workerResult.outputManifest) {
      throw new Error(`scenario ${scenario} returned no output manifest`);
    }
    if (!writesOutput && workerResult.outputManifest) {
      throw new Error(`check scenario unexpectedly returned an output manifest`);
    }
    if (workerResult.outputManifest) outputHashes.add(workerResult.outputManifest.sha256);
    if (warmup) {
      warmupOperationMs.push(workerResult.timing.operationMs);
    } else {
      rawSamples.push({ ...workerResult, sample: sampleNumber });
    }
  }

  if (outputHashes.size > 1) {
    throw new Error(
      `scenario ${scenario} produced nondeterministic output across isolated samples`,
    );
  }
  const engines = new Set(rawSamples.map((sample) => sample.engine));
  if (engines.size !== 1) throw new Error(`scenario ${scenario} used multiple engines`);
  const buildElapsed = rawSamples.flatMap((sample) =>
    typeof sample.build.elapsedMs === "number" ? [sample.build.elapsedMs] : [],
  );
  const result: ScenarioResult = {
    ...(buildElapsed.length ? { buildElapsedMs: summarize(buildElapsed) } : {}),
    buildPhases: aggregateBuildPhases(rawSamples),
    engine: rawSamples[0]?.engine ?? "unknown",
    fixture: fixtureMetadata(fixture),
    memory: {
      currentRssBytes: summarize(rawSamples.map((sample) => sample.memory.currentRssBytes)),
      heapUsedBytes: summarize(rawSamples.map((sample) => sample.memory.heapUsedBytes)),
      maxRssBytes: summarize(rawSamples.map((sample) => sample.memory.maxRssBytes)),
    },
    operationMs: summarize(rawSamples.map((sample) => sample.timing.operationMs)),
    ...(rawSamples[0]?.outputManifest ? { outputManifest: rawSamples[0].outputManifest } : {}),
    rawSamples,
    scenario,
    warmupOperationMs,
    workerWallMs: summarize(rawSamples.map((sample) => sample.workerWallMs)),
  };
  if (!captureOutput) return { result };
  const capturedOutput = path.join(runRoot, `captured-output-${fixture.pages}`);
  await rm(capturedOutput, { force: true, recursive: true });
  await rename(outputDirectory, capturedOutput);
  return { capturedOutput, result };
}

function formatMilliseconds(value: number): string {
  return value < 1 ? value.toFixed(3) : value < 100 ? value.toFixed(2) : value.toFixed(1);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function compressedBytes(counts: ByteCounts): string {
  if (!counts.files) return "—";
  return `${formatBytes(counts.rawBytes)} / ${formatBytes(counts.gzipBytes)} / ${formatBytes(counts.brotliBytes)}`;
}

function markdownReport(report: BenchmarkReport): string {
  const metadata = report.metadata;
  const lines = [
    "# Inkpath benchmark results",
    "",
    `Generated: ${metadata.generatedAt}`,
    "",
    `Inkpath: ${metadata.git.inkpathVersion}; commit ${metadata.git.commit ?? "unknown"}${metadata.git.dirty ? " (dirty)" : ""}; branch ${metadata.git.branch ?? "detached"}`,
    `Artifact: ${metadata.artifact.entry} \`${metadata.artifact.sha256}\`; ${metadata.artifact.files} files; ${formatBytes(metadata.artifact.bytes)}`,
    `Runtime: Node ${metadata.runtime.node}, ${metadata.runtime.platform} ${metadata.runtime.release}, ${metadata.runtime.arch}`,
    `Hardware: ${metadata.hardware.cpu}; ${metadata.hardware.logicalCpus} logical CPUs; ${formatBytes(metadata.hardware.totalMemoryBytes)} memory`,
    `Settings: ${metadata.options.samples} measured sample(s), ${metadata.options.warmups} warmup(s), profile ${metadata.options.profile}, engine ${metadata.options.engineMode}`,
    "",
    "Times are isolated-worker measurements. p95 uses nearest rank. Byte columns are raw / gzip-9 / Brotli-11 totals, compressed per file after timing.",
    "",
    "## Results",
    "",
    "| Pages | Scenario | Engine | Median | p95 | Max RSS p95 | HTML | CSS | JavaScript |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const result of report.results) {
    const output = result.output;
    lines.push(
      `| ${result.fixture.pages} | ${scenarioForId(result.scenario).label} | ${result.engine} | ${formatMilliseconds(result.operationMs.median)} ms | ${formatMilliseconds(result.operationMs.p95)} ms | ${formatBytes(result.memory.maxRssBytes.p95)} | ${output ? compressedBytes(output.html) : "—"} | ${output ? compressedBytes(output.css) : "—"} | ${output ? compressedBytes(output.javascript) : "—"} |`,
    );
  }

  lines.push("", "## Phase medians", "");
  for (const result of report.results) {
    const phases = Object.entries(result.buildPhases)
      .map(([name, summary]) => `${name}=${formatMilliseconds(summary.median)} ms`)
      .join(", ");
    lines.push(
      `- ${result.fixture.pages} pages, ${result.scenario}: ${phases || "phase timings unavailable"}`,
    );
  }

  lines.push("", "## Raw samples", "");
  for (const result of report.results) {
    lines.push(`### ${result.fixture.pages} pages — ${result.scenario}`, "");
    lines.push(
      `Fixture suite: \`${result.fixture.suiteSha256}\`; source manifest \`${result.fixture.manifestSha256}\`; mutations \`${result.fixture.mutationTargetsSha256}\`; ${result.fixture.manifestFiles} files; ${formatBytes(result.fixture.manifestBytes)}.`,
      "",
      `Output manifest: ${result.outputManifest ? `\`${result.outputManifest.sha256}\` (${result.outputManifest.files} files; ${formatBytes(result.outputManifest.bytes)})` : "none"}${result.canonicalBaselineOutputSha256 ? `; canonical baseline \`${result.canonicalBaselineOutputSha256}\`` : ""}.`,
      "",
      `Warmups: ${result.warmupOperationMs.length ? result.warmupOperationMs.map((value) => `${formatMilliseconds(value)} ms`).join(", ") : "none"}.`,
      "",
      "| Sample | Operation | Worker wall | buildSite elapsed | Current RSS | Max RSS | Heap used |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const sample of result.rawSamples) {
      lines.push(
        `| ${sample.sample} | ${formatMilliseconds(sample.timing.operationMs)} ms | ${formatMilliseconds(sample.workerWallMs)} ms | ${typeof sample.build.elapsedMs === "number" ? `${formatMilliseconds(sample.build.elapsedMs)} ms` : "—"} | ${formatBytes(sample.memory.currentRssBytes)} | ${formatBytes(sample.memory.maxRssBytes)} | ${formatBytes(sample.memory.heapUsedBytes)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeReport(target: string, contents: string): Promise<void> {
  if (target === "-") {
    process.stdout.write(contents);
    return;
  }
  const absolute = path.resolve(target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

function progress(options: RunnerOptions, message: string): void {
  if (!options.quiet) process.stderr.write(`${message}\n`);
}

function assertIdentityUnchanged(
  label: string,
  expected: TreeIdentity,
  actual: TreeIdentity,
): void {
  if (
    expected.sha256 !== actual.sha256 ||
    expected.files !== actual.files ||
    expected.bytes !== actual.bytes
  ) {
    throw new Error(`${label} changed while the benchmark was running; discard these results`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(help);
    return;
  }
  const options = parsed;
  try {
    await access(buildModule);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`missing ${buildModule}; run pnpm build before benchmarking`);
    }
    throw error;
  }
  const artifactRoot = path.dirname(buildModule);
  const artifact = await treeIdentity(artifactRoot);

  const runRoot = await mkdtemp(path.join(os.tmpdir(), "inkpath-benchmark-"));
  const results: ScenarioResult[] = [];
  const canonicalValidations: Array<{
    fixture: GeneratedBenchmarkSite;
    projectDirectory: string;
    result: ScenarioResult;
    scenario: ScenarioId;
  }> = [];
  const deferredOutputs: Array<{ outputDirectory: string; result: ScenarioResult }> = [];
  try {
    for (const pages of options.pages) {
      const fixtureRoot = path.join(runRoot, `fixture-${pages}`);
      progress(options, `Generating deterministic ${pages}-page ${options.profile} fixture...`);
      const fixture = await generateBenchmarkSite(fixtureRoot, {
        pages,
        profile: options.profile,
        ...(options.linkFanout === undefined ? {} : { linkFanout: options.linkFanout }),
      });
      const projectDirectory = path.join(runRoot, `working-${pages}`);
      await cp(fixture.root, projectDirectory, { recursive: true });
      const byteScenario = options.measureOutput
        ? (options.scenarios.find((scenario) => scenario === "clean-build") ??
          options.scenarios.find((scenario) => scenarioForId(scenario).operation !== "check"))
        : undefined;
      for (const scenario of options.scenarios) {
        progress(options, `Benchmarking ${pages} pages: ${scenario}...`);
        const run = await runScenario(
          runRoot,
          projectDirectory,
          fixture,
          scenario,
          options,
          scenario === byteScenario,
        );
        results.push(run.result);
        if (run.capturedOutput) {
          deferredOutputs.push({ outputDirectory: run.capturedOutput, result: run.result });
        }
        if (
          options.engineMode === "auto" &&
          run.result.engine !== "buildSite" &&
          scenarioForId(scenario).operation !== "check"
        ) {
          canonicalValidations.push({ fixture, projectDirectory, result: run.result, scenario });
        }
      }
    }

    assertIdentityUnchanged(artifactRoot, artifact, await treeIdentity(artifactRoot));
    for (const validation of canonicalValidations) {
      progress(
        options,
        `Validating ${validation.fixture.pages} pages: ${validation.scenario} against a clean baseline...`,
      );
      await restoreBenchmarkProject(
        validation.projectDirectory,
        validation.fixture.root,
        validation.fixture.mutationTargets,
      );
      const outputDirectory = path.join(validation.projectDirectory, "site");
      await rm(outputDirectory, { force: true, recursive: true });
      const canonical = await runWorker({
        buildModule,
        cleanAfterMutation: true,
        engineMode: "baseline",
        mutationTargets: validation.fixture.mutationTargets,
        oracle: validation.fixture.scenarioOracles[validation.scenario],
        outputDirectory,
        projectDirectory: validation.projectDirectory,
        scenario: validation.scenario,
      });
      const measuredHash = validation.result.outputManifest?.sha256;
      const canonicalHash = canonical.outputManifest?.sha256;
      if (!measuredHash || !canonicalHash || measuredHash !== canonicalHash) {
        throw new Error(
          `${validation.fixture.pages}-page ${validation.scenario} output does not match the canonical baseline build`,
        );
      }
      validation.result.canonicalBaselineOutputSha256 = canonicalHash;
    }
    for (const deferred of deferredOutputs) {
      progress(
        options,
        `Measuring compressed output bytes for ${deferred.result.fixture.pages} pages...`,
      );
      deferred.result.output = await outputByteCounts(deferred.outputDirectory);
    }
    assertIdentityUnchanged(artifactRoot, artifact, await treeIdentity(artifactRoot));

    const cpus = os.cpus();
    const report: BenchmarkReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      metadata: {
        generatedAt: new Date().toISOString(),
        artifact: {
          ...artifact,
          entry: path.relative(repositoryRoot, buildModule).split(path.sep).join("/"),
        },
        git: await repositoryMetadata(),
        hardware: {
          cpu: cpus[0]?.model ?? "unknown",
          logicalCpus: cpus.length,
          totalMemoryBytes: os.totalmem(),
        },
        options: {
          engineMode: options.engineMode,
          linkFanout: options.linkFanout ?? null,
          measureOutput: options.measureOutput,
          pages: options.pages,
          profile: options.profile,
          samples: options.samples,
          scenarios: options.scenarios,
          warmups: options.warmups,
        },
        runtime: {
          arch: process.arch,
          node: process.versions.node,
          platform: process.platform,
          release: os.release(),
          versions: process.versions,
        },
      },
      results,
    };
    const markdown = markdownReport(report);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.jsonPath) await writeReport(options.jsonPath, json);
    if (options.markdownPath) await writeReport(options.markdownPath, markdown);
    if (!options.jsonPath && !options.markdownPath) process.stdout.write(markdown);
  } finally {
    if (options.keepFixtures) {
      progress(options, `Kept benchmark fixtures at ${runRoot}`);
    } else {
      await rm(runRoot, { force: true, recursive: true });
    }
  }
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryPoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
