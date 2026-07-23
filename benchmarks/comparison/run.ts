import {
  access,
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPARISON_TOOLS,
  generateComparisonCorpus,
  projectComparisonCorpus,
  type ComparisonCorpus,
  type ComparisonProject,
  type ComparisonTool,
} from "./corpus.js";
import {
  assertArtifactIdentityUnchanged,
  fileIdentity,
  inspectToolProvenance,
  loadComparisonVersionLock,
  type FileIdentity,
  type LoadedComparisonVersionLock,
  type ToolProvenance,
} from "./provenance.js";
import {
  summarizeOutput,
  validateSemanticPages,
  type ByteCounts,
  type OutputCategory,
  type OutputSummary,
  type SemanticPageValidation,
} from "./output.js";
import { superviseCommand, type CommandSpec, type SupervisedCommandResult } from "./supervisor.js";

const COMPARISON_SCENARIOS = [
  "clean-production",
  "repeat-production",
  "body-edit-production",
] as const;

type ComparisonScenario = (typeof COMPARISON_SCENARIOS)[number];

export type MetricSummary = {
  median: number;
  p95: number;
};

export type ToolConfiguration = {
  executable?: string;
  toolRoot?: string;
};

type ComparisonRunnerOptions = {
  jsonPath?: string;
  markdownPath?: string;
  pages: number[];
  quiet: boolean;
  rssSampleIntervalMs: number;
  samples: number;
  scenarios: ComparisonScenario[];
  timeoutMs: number;
  toolConfigurations: Record<ComparisonTool, ToolConfiguration>;
  tools: ComparisonTool[];
  warmups: number;
  workRoot: string;
};

export type Installation = {
  configuredExecutable: string;
  executable: string;
  executableIdentity: FileIdentity;
  provenance: ToolProvenance;
  tool: ComparisonTool;
  toolRoot?: string;
  version: string;
};

type RawSample = {
  output: OutputSummary;
  peakProcessTreeRssBytes: number;
  processTreeRssSamples: number;
  sample: number;
  wallMs: number;
};

type OutputAggregate = {
  byCategory: Record<OutputCategory, Record<keyof ByteCounts, MetricSummary>>;
  files: MetricSummary;
  sha256: string[];
};

type ComparisonResult = {
  command: string;
  corpusSha256: string;
  output: OutputAggregate;
  pages: number;
  peakProcessTreeRssBytes: MetricSummary;
  projectManifestSha256: string;
  rawSamples: RawSample[];
  scenario: ComparisonScenario;
  semanticValidation: SemanticPageValidation;
  tool: ComparisonTool;
  wallMs: MetricSummary;
  warmupWallMs: number[];
};

const REPORT_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const repositoryRoot = path.resolve(process.cwd());
const PACKAGE_MANAGER_NAMES = new Set(["bun", "npm", "npx", "pnpm", "yarn", "yarnpkg"]);
const TOOL_ENV_PREFIX = "INKPATH_COMPARISON_";

const help = `Static-site generator production comparison

Compile before running:
  pnpm benchmark:compile
  node .inkpath-benchmark/runner/comparison/run.js [options]

Every selected tool needs a pinned executable path, supplied by a flag or the
matching INKPATH_COMPARISON_<TOOL>_EXECUTABLE environment variable.

Options:
  --tools <list>                 inkpath,hugo,mkdocs,docusaurus,quartz
  --pages <list>                 exact page counts (default: 100)
  --scenarios <list>             clean-production,repeat-production,body-edit-production
                                 (default: clean-production)
  --samples <n>                  measured isolated samples (default: 3)
  --warmups <n>                  discarded isolated samples (default: 1)
  --rss-sample-interval <ms>     process-tree RSS interval (default: 20)
  --timeout <ms>                 timeout for each generator process (default: 600000)
  --work-root <path>             parent for ephemeral projects (default: OS temp)
  --json <path|->                write complete JSON report
  --markdown <path|->            write Markdown report
  --quiet                        suppress progress messages
  --help                         show this help

Executable flags:
  --inkpath-executable <path>
  --hugo-executable <path>
  --mkdocs-executable <path>
  --docusaurus-executable <path>
  --quartz-executable <path>

Dependency roots (required for these generated projects):
  --docusaurus-root <path>       pinned install containing node_modules
  --quartz-root <path>           pinned Quartz checkout containing quartz,
                                 .quartz, node_modules, and package metadata

Root environment variables are INKPATH_COMPARISON_DOCUSAURUS_ROOT and
INKPATH_COMPARISON_QUARTZ_ROOT. The runner never invokes a package manager or
installer. JavaScript executable files are launched by this Node executable.
`;

export function envName(tool: ComparisonTool, suffix: "EXECUTABLE" | "ROOT"): string {
  return `${TOOL_ENV_PREFIX}${tool.toUpperCase()}_${suffix}`;
}

export function initialToolConfigurations(): Record<ComparisonTool, ToolConfiguration> {
  return Object.fromEntries(
    COMPARISON_TOOLS.map((tool) => {
      const executable = process.env[envName(tool, "EXECUTABLE")];
      const toolRoot = process.env[envName(tool, "ROOT")];
      return [
        tool,
        {
          ...(executable ? { executable } : {}),
          ...(toolRoot ? { toolRoot } : {}),
        },
      ];
    }),
  ) as Record<ComparisonTool, ToolConfiguration>;
}

export function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
  return value;
}

export function integer(value: string, option: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

export function commaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isComparisonTool(value: string): value is ComparisonTool {
  return COMPARISON_TOOLS.some((tool) => tool === value);
}

export function parseTools(value: string): ComparisonTool[] {
  return commaList(value).map((tool) => {
    if (!isComparisonTool(tool)) {
      throw new Error(`unsupported comparison tool: ${tool}`);
    }
    return tool;
  });
}

function isComparisonScenario(value: string): value is ComparisonScenario {
  return COMPARISON_SCENARIOS.some((scenario) => scenario === value);
}

function parseScenarios(value: string): ComparisonScenario[] {
  const aliases: Record<string, ComparisonScenario> = {
    "body-edit": "body-edit-production",
    clean: "clean-production",
    repeat: "repeat-production",
  };
  return commaList(value).map((scenario) => {
    const normalized = aliases[scenario] ?? scenario;
    if (!isComparisonScenario(normalized)) {
      throw new Error(`unsupported comparison scenario: ${scenario}`);
    }
    return normalized;
  });
}

function parseArguments(args: readonly string[]): ComparisonRunnerOptions | "help" {
  if (args.includes("--help")) return "help";
  const toolConfigurations = initialToolConfigurations();
  let explicitTools: ComparisonTool[] | undefined;
  const options: Omit<ComparisonRunnerOptions, "tools"> = {
    pages: [100],
    quiet: false,
    rssSampleIntervalMs: 20,
    samples: 3,
    scenarios: ["clean-production"],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    toolConfigurations,
    warmups: 1,
    workRoot: os.tmpdir(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--" && index === 0) continue;
    if (argument === "--tools") {
      explicitTools = parseTools(optionValue(args, index, argument));
      index += 1;
    } else if (argument === "--pages") {
      options.pages = commaList(optionValue(args, index, argument)).map((value) =>
        integer(value, argument),
      );
      index += 1;
    } else if (argument === "--scenarios") {
      options.scenarios = parseScenarios(optionValue(args, index, argument));
      index += 1;
    } else if (argument === "--samples") {
      options.samples = integer(optionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--warmups") {
      options.warmups = integer(optionValue(args, index, argument), argument, true);
      index += 1;
    } else if (argument === "--rss-sample-interval") {
      options.rssSampleIntervalMs = integer(optionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--timeout") {
      options.timeoutMs = integer(optionValue(args, index, argument), argument);
      index += 1;
    } else if (argument === "--work-root") {
      options.workRoot = path.resolve(optionValue(args, index, argument));
      index += 1;
    } else if (argument === "--json") {
      options.jsonPath = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--markdown") {
      options.markdownPath = optionValue(args, index, argument);
      index += 1;
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else {
      const executableTool = COMPARISON_TOOLS.find((tool) => argument === `--${tool}-executable`);
      if (executableTool) {
        options.toolConfigurations[executableTool] = {
          ...options.toolConfigurations[executableTool],
          executable: optionValue(args, index, argument),
        };
        index += 1;
        continue;
      }
      const rootTool = (["docusaurus", "quartz"] as const).find(
        (tool) => argument === `--${tool}-root`,
      );
      if (rootTool) {
        options.toolConfigurations[rootTool] = {
          ...options.toolConfigurations[rootTool],
          toolRoot: optionValue(args, index, argument),
        };
        index += 1;
        continue;
      }
      throw new Error(`unknown option: ${String(argument)}`);
    }
  }

  const tools =
    explicitTools ??
    COMPARISON_TOOLS.filter((tool) => options.toolConfigurations[tool].executable !== undefined);
  if (!tools.length) {
    throw new Error(
      "select --tools and supply pinned executable paths, or configure them in the environment",
    );
  }
  if (!options.pages.length) throw new Error("--pages must include at least one page count");
  if (options.pages.some((pages) => pages < 20)) {
    throw new Error("comparison corpora require at least 20 pages");
  }
  if (!options.scenarios.length) throw new Error("--scenarios must include at least one scenario");
  if (options.jsonPath === "-" && options.markdownPath === "-") {
    throw new Error("JSON and Markdown cannot both be written to stdout");
  }
  for (const tool of tools) {
    if (!options.toolConfigurations[tool].executable) {
      throw new Error(`${tool} needs --${tool}-executable or ${envName(tool, "EXECUTABLE")}`);
    }
    if (
      (tool === "docusaurus" || tool === "quartz") &&
      !options.toolConfigurations[tool].toolRoot
    ) {
      throw new Error(`${tool} needs --${tool}-root or ${envName(tool, "ROOT")}`);
    }
  }
  return { ...options, tools };
}

export function median(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function nearestRankP95(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function summarize(values: readonly number[]): MetricSummary {
  return { median: median(values), p95: nearestRankP95(values) };
}

function offlineEnvironment(projectRoot?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: "1",
    DOCUSAURUS_TELEMETRY_DISABLED: "true",
    FORCE_COLOR: "0",
    HUGO_ENVIRONMENT: "production",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    SOURCE_DATE_EPOCH: "946684800",
    TZ: "UTC",
    YARN_ENABLE_NETWORK: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    ...(projectRoot
      ? {
          BABEL_CACHE_PATH: path.join(projectRoot, ".cache", "babel.json"),
          HUGO_CACHEDIR: path.join(projectRoot, ".hugo-cache"),
          PYTHONDONTWRITEBYTECODE: "1",
          XDG_CACHE_HOME: path.join(projectRoot, ".cache"),
          YARN_CACHE_FOLDER: path.join(projectRoot, ".cache", "yarn"),
          npm_config_cache: path.join(projectRoot, ".cache", "npm"),
        }
      : {}),
  };
}

function versionArguments(tool: ComparisonTool): string[] {
  return tool === "hugo" ? ["version"] : ["--version"];
}

async function commandVersion(
  tool: ComparisonTool,
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await superviseCommand(
    {
      args: versionArguments(tool),
      cwd,
      env: environment,
      executable,
    },
    { rssSampleIntervalMs: 100, timeoutMs: 30_000 },
  );
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.exitCode !== 0) {
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(
      `${tool} version command failed (${result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`})${detail ? `:\n${detail}` : ""}`,
    );
  }
  const output = stdout || stderr;
  const firstLine = output.split(/\r?\n/)[0];
  if (!firstLine) throw new Error(`${tool} version command returned no output`);
  return firstLine;
}

export async function prepareInstallation(
  tool: ComparisonTool,
  configuration: ToolConfiguration,
  versionLock: LoadedComparisonVersionLock,
  versionEnvironment: NodeJS.ProcessEnv = offlineEnvironment(),
): Promise<Installation> {
  if (!configuration.executable) throw new Error(`missing executable for ${tool}`);
  const configuredExecutable = path.resolve(configuration.executable);
  const executable = await realpath(configuredExecutable);
  const extension = path.extname(executable).toLowerCase();
  if (extension !== ".js" && extension !== ".cjs" && extension !== ".mjs") {
    await access(executable, fsConstants.X_OK);
  }
  if (
    PACKAGE_MANAGER_NAMES.has(path.basename(configuredExecutable)) ||
    PACKAGE_MANAGER_NAMES.has(path.basename(executable))
  ) {
    throw new Error(`${tool} executable must not be a package manager or on-demand runner`);
  }

  let toolRoot: string | undefined;
  if (configuration.toolRoot) {
    toolRoot = await realpath(path.resolve(configuration.toolRoot));
    if (!(await stat(toolRoot)).isDirectory())
      throw new Error(`tool root is not a directory: ${toolRoot}`);
  }
  const reportedVersion = await commandVersion(
    tool,
    executable,
    toolRoot ?? repositoryRoot,
    versionEnvironment,
  );
  const inspection = await inspectToolProvenance({
    executable,
    lock: versionLock,
    reportedVersion,
    repositoryRoot,
    tool,
    ...(toolRoot ? { toolRoot } : {}),
  });
  return {
    configuredExecutable,
    executable,
    executableIdentity: await fileIdentity(executable),
    provenance: inspection.provenance,
    tool,
    ...(toolRoot ? { toolRoot } : {}),
    version: inspection.version,
  };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function linkInstallEntry(
  projectRoot: string,
  installRoot: string,
  name: string,
  required: boolean,
): Promise<void> {
  const destination = path.join(projectRoot, name);
  if (await pathExists(destination)) return;
  const source = path.join(installRoot, name);
  let sourceMetadata;
  try {
    sourceMetadata = await stat(source);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`pinned install is missing ${source}`, { cause: error });
  }
  await symlink(source, destination, sourceMetadata.isDirectory() ? "dir" : "file");
}

export async function overlayQuartzSources(
  projectRoot: string,
  installRoot: string,
): Promise<void> {
  const source = path.join(installRoot, "quartz");
  if (!(await stat(source)).isDirectory()) {
    throw new Error(`Quartz root has no source directory: ${source}`);
  }
  const destination = path.join(projectRoot, "quartz");
  await mkdir(destination);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    // Quartz writes its transpiled build cache below the source directory. Keep
    // that cache local to this fresh sample rather than mutating the pinned
    // checkout or letting one measured sample warm another.
    if (entry.name === ".quartz-cache") continue;
    // Quartz starts this module by its project-relative path, but Node resolves
    // an ESM symlink to the pinned checkout before resolving the worker cache's
    // relative import. Copy the tiny bootstrap so its `.quartz-cache` import
    // stays inside the isolated sample overlay.
    if (entry.name === "bootstrap-worker.mjs") {
      await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
      continue;
    }
    await symlink(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
}

export async function prepareToolProject(
  project: ComparisonProject,
  installation: Installation,
): Promise<void> {
  if (project.tool === "docusaurus") {
    if (!installation.toolRoot) throw new Error("Docusaurus needs a pinned tool root");
    const modulesRoot =
      path.basename(installation.toolRoot) === "node_modules"
        ? installation.toolRoot
        : path.join(installation.toolRoot, "node_modules");
    if (!(await stat(modulesRoot)).isDirectory()) {
      throw new Error(`Docusaurus root has no node_modules directory: ${installation.toolRoot}`);
    }
    await symlink(modulesRoot, path.join(project.root, "node_modules"), "dir");
    return;
  }
  if (project.tool !== "quartz") return;
  if (!installation.toolRoot) throw new Error("Quartz needs a pinned checkout root");
  await overlayQuartzSources(project.root, installation.toolRoot);
  for (const name of [".quartz", "node_modules", "package.json"] as const) {
    await linkInstallEntry(project.root, installation.toolRoot, name, true);
  }
  for (const name of ["quartz.ts", "tsconfig.json"] as const) {
    await linkInstallEntry(project.root, installation.toolRoot, name, false);
  }
}

function buildCommand(project: ComparisonProject, installation: Installation): CommandSpec {
  const common = {
    cwd: project.root,
    env: offlineEnvironment(project.root),
    executable: installation.executable,
  };
  if (project.tool === "inkpath") {
    return { ...common, args: ["build", project.root] };
  }
  if (project.tool === "hugo") {
    return {
      ...common,
      args: [
        "--source",
        project.root,
        "--destination",
        project.outputDirectory,
        "--config",
        project.configPath,
        "--environment",
        "production",
        "--quiet",
      ],
    };
  }
  if (project.tool === "mkdocs") {
    return {
      ...common,
      args: [
        "build",
        "--config-file",
        project.configPath,
        "--site-dir",
        project.outputDirectory,
        "--clean",
        "--strict",
        "--quiet",
      ],
    };
  }
  if (project.tool === "docusaurus") {
    return {
      ...common,
      args: ["build", ".", "--out-dir", project.outputDirectory],
    };
  }
  return {
    ...common,
    args: ["build", "--directory", project.contentDirectory, "--output", project.outputDirectory],
  };
}

function commandDescription(command: CommandSpec, project: ComparisonProject): string {
  const replace = (value: string): string =>
    value
      .replaceAll(project.outputDirectory, "$OUTPUT")
      .replaceAll(project.contentDirectory, "$CONTENT")
      .replaceAll(project.configPath, "$CONFIG")
      .replaceAll(project.root, "$PROJECT");
  return [command.executable, ...command.args].map(replace).join(" ");
}

function commandFailure(
  tool: ComparisonTool,
  phase: string,
  result: SupervisedCommandResult,
): Error {
  const details = (result.stderr || result.stdout).trim().slice(-8_000);
  return new Error(
    `${tool} ${phase} failed (${result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`})${details ? `:\n${details}` : ""}`,
  );
}

async function executeBuild(
  project: ComparisonProject,
  installation: Installation,
  options: ComparisonRunnerOptions,
  phase: string,
): Promise<SupervisedCommandResult> {
  const result = await superviseCommand(buildCommand(project, installation), {
    rssSampleIntervalMs: options.rssSampleIntervalMs,
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0) throw commandFailure(project.tool, phase, result);
  return result;
}

function assertProjectPaths(project: ComparisonProject, expectedRoot: string): void {
  const root = path.resolve(expectedRoot);
  if (path.resolve(project.root) !== root) throw new Error("projector returned an unexpected root");
  for (const [label, candidate] of [
    ["content", project.contentDirectory],
    ["config", project.configPath],
    ["output", project.outputDirectory],
    ["mutation", path.resolve(project.root, project.mutation.path)],
  ] as const) {
    const relative = path.relative(root, path.resolve(candidate));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} path must be a child of the generated project: ${candidate}`);
    }
  }
}

async function applyBodyMutation(project: ComparisonProject): Promise<void> {
  const sourcePath = path.resolve(project.root, project.mutation.path);
  const current = await readFile(sourcePath, "utf8");
  if (current !== project.mutation.before) {
    throw new Error(
      `body-edit source did not match its pristine fixture: ${project.mutation.path}`,
    );
  }
  const temporary = `${sourcePath}.comparison-${process.pid}.tmp`;
  await writeFile(temporary, project.mutation.after, "utf8");
  await rename(temporary, sourcePath);
}

async function validateScenarioOutput(
  project: ComparisonProject,
  scenario: ComparisonScenario,
): Promise<SemanticPageValidation> {
  const bodyEdited = scenario === "body-edit-production";
  return validateSemanticPages(project.outputDirectory, project.expectedPages, {
    expectedMarker: bodyEdited ? project.mutation.expectedMarker : project.mutation.forbiddenMarker,
    forbiddenMarker: bodyEdited
      ? project.mutation.forbiddenMarker
      : project.mutation.expectedMarker,
    sourcePath: project.mutation.path,
  });
}

function aggregateOutput(outputs: readonly OutputSummary[]): OutputAggregate {
  const categories = Object.fromEntries(
    (["html", "css", "javascript", "other"] as const).map((category) => [
      category,
      Object.fromEntries(
        (["files", "rawBytes", "gzipBytes", "brotliBytes"] as const).map((field) => [
          field,
          summarize(outputs.map((output) => output.byCategory[category][field])),
        ]),
      ),
    ]),
  ) as OutputAggregate["byCategory"];
  return {
    byCategory: categories,
    files: summarize(outputs.map((output) => output.files)),
    sha256: [...new Set(outputs.map((output) => output.sha256))].sort(),
  };
}

export function progress(options: { quiet: boolean }, message: string): void {
  if (!options.quiet) process.stderr.write(`${message}\n`);
}

async function runScenario(
  runRoot: string,
  corpus: ComparisonCorpus,
  installation: Installation,
  scenario: ComparisonScenario,
  options: ComparisonRunnerOptions,
): Promise<ComparisonResult> {
  const rawSamples: RawSample[] = [];
  const warmupWallMs: number[] = [];
  let semanticValidation: SemanticPageValidation | undefined;
  let command = "";
  let projectManifestSha256 = "";
  const iterations = options.warmups + options.samples;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const warmup = iteration < options.warmups;
    const sample = warmup ? iteration + 1 : iteration - options.warmups + 1;
    // Recreate every isolated sample at the same absolute path. Some bundlers
    // embed their project root into generated modules, so varying the directory
    // name would introduce a benchmark-controlled output difference between
    // otherwise identical samples.
    const sampleRoot = path.join(
      runRoot,
      `${corpus.pages}-${installation.tool}-${scenario}-project`,
    );
    try {
      const project = await projectComparisonCorpus(corpus, installation.tool, sampleRoot);
      assertProjectPaths(project, sampleRoot);
      projectManifestSha256 ||= project.manifestSha256;
      if (projectManifestSha256 !== project.manifestSha256) {
        throw new Error("projector produced a nondeterministic source manifest");
      }
      await prepareToolProject(project, installation);
      await rm(project.outputDirectory, { force: true, recursive: true });
      const specification = buildCommand(project, installation);
      command ||= commandDescription(specification, project);

      if (scenario !== "clean-production") {
        await executeBuild(project, installation, options, "untimed initial production build");
      }
      if (scenario === "body-edit-production") await applyBodyMutation(project);

      const result = await executeBuild(project, installation, options, "timed production build");
      const validation = await validateScenarioOutput(project, scenario);
      if (semanticValidation && JSON.stringify(semanticValidation) !== JSON.stringify(validation)) {
        throw new Error("semantic validation counts changed between isolated samples");
      }
      semanticValidation = validation;
      if (warmup) {
        warmupWallMs.push(result.wallMs);
      } else {
        const output = await summarizeOutput(project.outputDirectory);
        rawSamples.push({
          output,
          peakProcessTreeRssBytes: result.peakProcessTreeRssBytes,
          processTreeRssSamples: result.processTreeRssSamples,
          sample,
          wallMs: result.wallMs,
        });
      }
    } finally {
      await rm(sampleRoot, { force: true, recursive: true });
    }
  }
  if (!semanticValidation) throw new Error("comparison scenario produced no semantic validation");
  return {
    command,
    corpusSha256: corpus.sha256,
    output: aggregateOutput(rawSamples.map((sample) => sample.output)),
    pages: corpus.pages,
    peakProcessTreeRssBytes: summarize(rawSamples.map((sample) => sample.peakProcessTreeRssBytes)),
    projectManifestSha256,
    rawSamples,
    scenario,
    semanticValidation,
    tool: installation.tool,
    wallMs: summarize(rawSamples.map((sample) => sample.wallMs)),
    warmupWallMs,
  };
}

export function formatMilliseconds(value: number): string {
  return value < 1 ? value.toFixed(3) : value < 100 ? value.toFixed(2) : value.toFixed(1);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function scenarioLabel(scenario: ComparisonScenario): string {
  if (scenario === "clean-production") return "Clean production build";
  if (scenario === "repeat-production") return "Repeat one-shot production build";
  return "Body-edit one-shot production build";
}

function markdownReport(report: {
  metadata: {
    generatedAt: string;
    hardware: { cpu: string; logicalCpus: number; totalMemoryBytes: number };
    installations: Installation[];
    options: {
      rssSampleIntervalMs: number;
      samples: number;
      scenarios: ComparisonScenario[];
      warmups: number;
    };
    runtime: { arch: string; node: string; platform: string; release: string };
    versionLock: FileIdentity & { recordedAt: string; schemaVersion: number };
  };
  results: ComparisonResult[];
}): string {
  const lines = [
    "# Static-site generator production comparison",
    "",
    `Generated: ${report.metadata.generatedAt}`,
    "",
    `Runtime: Node ${report.metadata.runtime.node}, ${report.metadata.runtime.platform} ${report.metadata.runtime.release}, ${report.metadata.runtime.arch}`,
    `Hardware: ${report.metadata.hardware.cpu}; ${report.metadata.hardware.logicalCpus} logical CPUs; ${formatBytes(report.metadata.hardware.totalMemoryBytes)} memory`,
    `Settings: ${report.metadata.options.samples} measured sample(s), ${report.metadata.options.warmups} warmup(s), ${report.metadata.options.rssSampleIntervalMs} ms RSS sampling`,
    `Version lock: schema ${report.metadata.versionLock.schemaVersion}, recorded ${report.metadata.versionLock.recordedAt}, SHA-256 \`${report.metadata.versionLock.sha256}\``,
    "",
    "Each sample uses a fresh projected corpus and a fresh production CLI process. Clean builds start without an output directory or project-local build cache. Repeat and body-edit measurements first run an untimed production build, retain its output and project-local production caches, and then time another fresh one-shot production process. They are not dev-server or persistent incremental-engine measurements. Semantic validation, output hashing, compression, project creation, mutation, and cleanup are outside timing.",
    "",
    "The corpus, links, headings, code blocks, assets, and semantic sentinels are equivalent, but each generator uses its documented native production pipeline and a small native theme/configuration. Output feature sets and theme complexity are therefore not identical; interpret timing and output weight together rather than as a universal fastest-generator ranking.",
    "",
    "The runner invokes only the recorded preinstalled executables, never a package manager or installer, and requests offline package-manager behavior. p95 uses nearest rank. RSS is the highest sampled sum for the generator process and all descendants. Compressed totals use gzip-9 and Brotli-11 independently per output file.",
    "",
    "## Tool identities",
    "",
    "| Tool | Version | Executable SHA-256 | Executable | Tool root |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const installation of report.metadata.installations) {
    lines.push(
      `| ${installation.tool} | ${escapeTable(installation.version)} | \`${installation.executableIdentity.sha256}\` | \`${escapeTable(installation.executable)}\` | ${installation.toolRoot ? `\`${escapeTable(installation.toolRoot)}\`` : "—"} |`,
    );
  }
  lines.push("", "### Verified installation provenance", "");
  for (const installation of report.metadata.installations) {
    const provenance = installation.provenance;
    lines.push(
      `- ${installation.tool}: provenance SHA-256 \`${provenance.identitySha256}\`; verified against lock \`${provenance.verifiedLockSha256}\`.`,
    );
    if (provenance.artifact) {
      lines.push(
        `  Complete dist tree: ${provenance.artifact.files} files, ${formatBytes(provenance.artifact.bytes)}, SHA-256 \`${provenance.artifact.sha256}\`, root \`${provenance.artifact.root}\`.`,
      );
    }
    for (const file of provenance.files) {
      lines.push(
        `  File: \`${file.path}\` (${formatBytes(file.bytes)}), SHA-256 \`${file.sha256}\`.`,
      );
    }
    if (provenance.python) {
      const distributions = provenance.python.distributions
        .map((distribution) => `${distribution.normalizedName}==${distribution.version}`)
        .join(", ");
      lines.push(
        `  Python: ${provenance.python.implementation} ${provenance.python.version}; executable SHA-256 \`${provenance.python.executable.sha256}\`; distribution inventory SHA-256 \`${provenance.python.inventorySha256}\` (${distributions}).`,
      );
    }
    if (provenance.pluginCheckouts) {
      for (const [name, checkout] of Object.entries(provenance.pluginCheckouts)) {
        lines.push(
          `  Quartz plugin ${name}: commit \`${checkout.git.commit ?? "unknown"}\`; package-lock SHA-256 \`${checkout.packageLock.sha256}\`${checkout.git.dirtyPaths.length ? `; recorded dirty paths ${checkout.git.dirtyPaths.map((dirtyPath) => `\`${dirtyPath}\``).join(", ")}` : ""}.`,
        );
      }
    }
    if (provenance.git) {
      lines.push(
        `  Git: commit \`${provenance.git.commit ?? "unknown"}\`; branch ${provenance.git.branch ? `\`${provenance.git.branch}\`` : "detached"}; ${provenance.git.dirty ? "dirty" : "clean"}.`,
      );
      if (provenance.git.dirtyPaths.length) {
        lines.push(
          `  Dirty paths: ${provenance.git.dirtyPaths.map((dirtyPath) => `\`${dirtyPath}\``).join(", ")}.`,
        );
      }
    }
  }
  lines.push(
    "",
    "## Timings",
    "",
    "| Pages | Tool | Scenario | Median | p95 | Process-tree RSS median | Process-tree RSS p95 |",
    "| ---: | --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const result of report.results) {
    lines.push(
      `| ${result.pages} | ${result.tool} | ${scenarioLabel(result.scenario)} | ${formatMilliseconds(result.wallMs.median)} ms | ${formatMilliseconds(result.wallMs.p95)} ms | ${formatBytes(result.peakProcessTreeRssBytes.median)} | ${formatBytes(result.peakProcessTreeRssBytes.p95)} |`,
    );
  }
  lines.push(
    "",
    "## Generated output",
    "",
    "Counts are medians across measured samples. Byte totals are raw / gzip-9 / Brotli-11.",
    "",
    "| Pages | Tool | Scenario | Category | Files | Bytes |",
    "| ---: | --- | --- | --- | ---: | ---: |",
  );
  for (const result of report.results) {
    for (const category of ["html", "css", "javascript", "other"] as const) {
      const counts = result.output.byCategory[category];
      lines.push(
        `| ${result.pages} | ${result.tool} | ${scenarioLabel(result.scenario)} | ${category} | ${Math.round(counts.files.median)} | ${formatBytes(counts.rawBytes.median)} / ${formatBytes(counts.gzipBytes.median)} / ${formatBytes(counts.brotliBytes.median)} |`,
      );
    }
  }
  lines.push("", "## Raw samples", "");
  for (const result of report.results) {
    lines.push(
      `### ${result.pages} pages — ${result.tool} — ${scenarioLabel(result.scenario)}`,
      "",
      `Corpus: \`${result.corpusSha256}\`; projected source: \`${result.projectManifestSha256}\`; validated ${result.semanticValidation.pages} routed page bodies, ${result.semanticValidation.anchors} heading anchors, ${result.semanticValidation.links} internal links, ${result.semanticValidation.assets} local assets, and ${result.semanticValidation.codeBlocks} code blocks; distinct output hashes: ${result.output.sha256.length}.`,
      "",
      `Command: \`${escapeTable(result.command)}\``,
      "",
      "| Sample | Wall | Peak process-tree RSS | RSS snapshots | Output SHA-256 |",
      "| ---: | ---: | ---: | ---: | --- |",
    );
    for (const sample of result.rawSamples) {
      lines.push(
        `| ${sample.sample} | ${formatMilliseconds(sample.wallMs)} ms | ${formatBytes(sample.peakProcessTreeRssBytes)} | ${sample.processTreeRssSamples} | \`${sample.output.sha256}\` |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeReport(target: string, contents: string): Promise<void> {
  if (target === "-") {
    process.stdout.write(contents);
    return;
  }
  const absolute = path.resolve(target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function runComparison(options: ComparisonRunnerOptions): Promise<{
  metadata: {
    generatedAt: string;
    hardware: { cpu: string; logicalCpus: number; totalMemoryBytes: number };
    installations: Installation[];
    options: {
      pages: number[];
      rssSampleIntervalMs: number;
      samples: number;
      scenarios: ComparisonScenario[];
      tools: ComparisonTool[];
      warmups: number;
    };
    runtime: { arch: string; node: string; platform: string; release: string };
    versionLock: FileIdentity & { recordedAt: string; schemaVersion: number };
  };
  results: ComparisonResult[];
  schemaVersion: number;
}> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("comparison RSS sampling currently supports macOS and Linux only");
  }
  progress(options, "Loading checked-in comparison version lock...");
  const versionLock = await loadComparisonVersionLock(repositoryRoot);
  const installations: Installation[] = [];
  for (const tool of options.tools) {
    progress(options, `Inspecting pinned ${tool} installation...`);
    installations.push(
      await prepareInstallation(tool, options.toolConfigurations[tool], versionLock),
    );
  }
  await mkdir(options.workRoot, { recursive: true });
  const runRoot = await mkdtemp(path.join(options.workRoot, "inkpath-comparison-"));
  const results: ComparisonResult[] = [];
  try {
    for (const pages of options.pages) {
      progress(options, `Preparing deterministic ${pages}-page comparison corpus...`);
      const corpus = generateComparisonCorpus({ pages });
      for (const installation of installations) {
        for (const scenario of options.scenarios) {
          progress(options, `Benchmarking ${installation.tool}: ${pages} pages, ${scenario}...`);
          results.push(await runScenario(runRoot, corpus, installation, scenario, options));
        }
      }
    }
  } finally {
    await rm(runRoot, { force: true, recursive: true });
  }
  await Promise.all(
    installations.map((installation) => assertArtifactIdentityUnchanged(installation.provenance)),
  );
  const cpus = os.cpus();
  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      hardware: {
        cpu: cpus[0]?.model ?? "unknown",
        logicalCpus: cpus.length,
        totalMemoryBytes: os.totalmem(),
      },
      installations,
      options: {
        pages: options.pages,
        rssSampleIntervalMs: options.rssSampleIntervalMs,
        samples: options.samples,
        scenarios: options.scenarios,
        tools: options.tools,
        warmups: options.warmups,
      },
      runtime: {
        arch: process.arch,
        node: process.versions.node,
        platform: process.platform,
        release: os.release(),
      },
      versionLock: {
        ...versionLock.identity,
        recordedAt: versionLock.data.recordedAt,
        schemaVersion: versionLock.data.schemaVersion,
      },
    },
    results,
    schemaVersion: REPORT_SCHEMA_VERSION,
  };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(help);
    return;
  }
  const report = await runComparison(parsed);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = markdownReport(report);
  if (parsed.jsonPath) await writeReport(parsed.jsonPath, json);
  if (parsed.markdownPath) await writeReport(parsed.markdownPath, markdown);
  if (!parsed.jsonPath && !parsed.markdownPath) process.stdout.write(markdown);
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
