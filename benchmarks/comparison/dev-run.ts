import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
  buildStartDetector,
  completionDetector,
  type LogEvent,
  type LogTimeline,
  PersistentDevelopmentProcess,
  readyDetector,
} from "./dev-supervisor.js";
import { validateSemanticPages, type SemanticPageValidation } from "./output.js";
import {
  assertArtifactIdentityUnchanged,
  loadComparisonVersionLock,
  type FileIdentity,
} from "./provenance.js";
import {
  commaList,
  envName,
  escapeTable,
  formatBytes,
  formatMilliseconds,
  initialToolConfigurations,
  integer,
  optionValue,
  parseTools,
  prepareInstallation,
  prepareToolProject,
  progress,
  summarize,
  writeReport,
  type Installation,
  type MetricSummary,
  type ToolConfiguration,
} from "./run.js";
import { superviseCommand, type CommandSpec } from "./supervisor.js";

export type DevelopmentRunnerOptions = {
  httpTimeoutMs: number;
  jsonPath?: string;
  markdownPath?: string;
  pages: number[];
  quiet: boolean;
  rssSampleIntervalMs: number;
  samples: number;
  timeoutMs: number;
  toolConfigurations: Record<ComparisonTool, ToolConfiguration>;
  tools: ComparisonTool[];
  warmups: number;
  workRoot: string;
};

type DevelopmentSample = {
  completionLine: string;
  sample: number;
  variant: "a" | "b";
  wallMs: number;
};

type SemanticEvidence = {
  browserVisibilityVerified: false;
  markers: string[];
  oracle: "http-body" | "production-output";
  productionPages?: SemanticPageValidation;
};

type DevelopmentResult = {
  command: string;
  corpusSha256: string;
  metric: "edit-start-to-watcher-build-complete";
  pages: number;
  peakProcessTreeRssBytes: number;
  processTreeRssSamples: number;
  projectManifestSha256: string;
  rawSamples: DevelopmentSample[];
  semanticEvidence: SemanticEvidence;
  tool: ComparisonTool;
  wallMs: MetricSummary;
  warmupWallMs: number[];
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const REPORT_SCHEMA_VERSION = 1;
const repositoryRoot = path.resolve(process.cwd());

const help = `Static-site generator persistent development comparison

Compile before running:
  pnpm benchmark:compile
  node .inkpath-benchmark/runner/comparison/dev-run.js [options]

This measures edit-start-to-watcher-build-complete: equal-length positioned
source write/fsync/close through the generator's native watcher/debounce and
build-complete log. It excludes browser reload, browser rendering, semantic
validation, and setup.

Options:
  --tools <list>                 inkpath,hugo,mkdocs,docusaurus,quartz
  --pages <list>                 exact page counts (default: 100)
  --samples <n>                  measured alternating body edits (default: 7)
  --warmups <n>                  discarded alternating body edits (default: 2)
  --rss-sample-interval <ms>     process-tree RSS interval (default: 20)
  --timeout <ms>                 startup and rebuild log timeout (default: 600000)
  --http-timeout <ms>            untimed HTTP readiness timeout (default: 60000)
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

Dependency roots:
  --docusaurus-root <path>       pinned install containing node_modules
  --quartz-root <path>           pinned Quartz checkout containing source,
                                 plugins, node_modules, and package metadata

The equivalent environment variables are INKPATH_COMPARISON_<TOOL>_EXECUTABLE,
INKPATH_COMPARISON_DOCUSAURUS_ROOT, and INKPATH_COMPARISON_QUARTZ_ROOT. This
runner never invokes a package manager or installer.
`;

export function parseDevelopmentArguments(
  args: readonly string[],
): DevelopmentRunnerOptions | "help" {
  if (args.includes("--help")) return "help";
  const toolConfigurations = initialToolConfigurations();
  let explicitTools: ComparisonTool[] | undefined;
  const options: Omit<DevelopmentRunnerOptions, "tools"> = {
    httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    pages: [100],
    quiet: false,
    rssSampleIntervalMs: 20,
    samples: 7,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    toolConfigurations,
    warmups: 2,
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
    } else if (argument === "--http-timeout") {
      options.httpTimeoutMs = integer(optionValue(args, index, argument), argument);
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
  if (!options.pages.length || options.pages.some((pages) => pages < 20)) {
    throw new Error("comparison corpora require at least 20 pages");
  }
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

function developmentEnvironment(projectRoot?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROWSER: "none",
    CI: "1",
    DOCUSAURUS_TELEMETRY_DISABLED: "true",
    FORCE_COLOR: "0",
    HUGO_ENVIRONMENT: "development",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "development",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    PYTHONUNBUFFERED: "1",
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
          XDG_CACHE_HOME: path.join(projectRoot, ".cache"),
          YARN_CACHE_FOLDER: path.join(projectRoot, ".cache", "yarn"),
          npm_config_cache: path.join(projectRoot, ".cache", "npm"),
        }
      : {}),
  };
}

async function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a local benchmark port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function serverCommand(
  project: ComparisonProject,
  installation: Installation,
  host: string,
  port: number,
  websocketPort: number,
): CommandSpec {
  const common = {
    cwd: project.root,
    env: developmentEnvironment(project.root),
    executable: installation.executable,
  };
  if (project.tool === "inkpath") {
    return { ...common, args: ["dev", project.root, "--host", host, "--port", String(port)] };
  }
  if (project.tool === "hugo") {
    return {
      ...common,
      args: [
        "server",
        "--source",
        project.root,
        "--bind",
        host,
        "--port",
        String(port),
        "--noHTTPCache",
      ],
    };
  }
  if (project.tool === "mkdocs") {
    return {
      ...common,
      args: ["serve", "--config-file", project.configPath, "--dev-addr", `${host}:${port}`],
    };
  }
  if (project.tool === "docusaurus") {
    return {
      ...common,
      args: ["start", ".", "--host", host, "--port", String(port), "--no-open"],
    };
  }
  return {
    ...common,
    args: [
      "build",
      "--serve",
      "--directory",
      project.contentDirectory,
      "--output",
      project.outputDirectory,
      "--port",
      String(port),
      "--wsPort",
      String(websocketPort),
    ],
  };
}

function commandDescription(
  command: CommandSpec,
  project: ComparisonProject,
  port: number,
  websocketPort: number,
): string {
  const replace = (value: string): string =>
    value
      .replaceAll(project.outputDirectory, "$OUTPUT")
      .replaceAll(project.contentDirectory, "$CONTENT")
      .replaceAll(project.configPath, "$CONFIG")
      .replaceAll(project.root, "$PROJECT")
      .replaceAll(String(websocketPort), "$WS_PORT")
      .replaceAll(String(port), "$PORT");
  return [command.executable, ...command.args].map(replace).join(" ");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

async function waitForHttpBody(
  url: string,
  requiredMarker: string,
  forbiddenMarker: string | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const separator = url.includes("?") ? "&" : "?";
      const body = await fetchText(`${url}${separator}comparison=${Date.now()}`, 5_000);
      if (body.includes(requiredMarker) && (!forbiddenMarker || !body.includes(forbiddenMarker))) {
        return;
      }
      lastError = new Error(`HTTP body did not contain ${requiredMarker}`);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timed out validating ${url}: ${String(lastError)}`);
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      await fetchText(url, Math.min(5_000, Math.max(1, deadline - performance.now())));
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

export type InPlaceEditWindow = {
  closedAt: number;
  editStartedAt: number;
};

/** Overwrite an equal-length fixture without replacing or truncating its watched inode. */
export async function writeInPlaceAndClose(
  file: string,
  contents: string,
  markEditStart: () => number = () => performance.now(),
): Promise<InPlaceEditWindow> {
  const handle = await open(file, "r+");
  let editStartedAt: number;
  try {
    const contentsBuffer = Buffer.from(contents);
    const metadata = await handle.stat();
    if (metadata.size !== contentsBuffer.byteLength) {
      throw new Error(
        `in-place development variants must have equal byte lengths (${metadata.size} !== ${contentsBuffer.byteLength})`,
      );
    }
    editStartedAt = markEditStart();
    if (!Number.isFinite(editStartedAt)) throw new Error("edit start timestamp must be finite");
    let offset = 0;
    while (offset < contentsBuffer.byteLength) {
      const { bytesWritten } = await handle.write(
        contentsBuffer,
        offset,
        contentsBuffer.byteLength - offset,
        offset,
      );
      if (bytesWritten < 1) throw new Error("positioned source write made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { closedAt: performance.now(), editStartedAt };
}

function matchingEvents(
  timeline: LogTimeline,
  checkpoint: number,
  detector: (event: LogEvent) => boolean,
): LogEvent[] {
  return timeline.eventsAfter(checkpoint).filter((event) => detector(event));
}

export function assertNoPendingBuildActivity(
  timeline: LogTimeline,
  tool: ComparisonTool,
  afterSequence: number,
): void {
  const unexpectedCompletion = matchingEvents(timeline, afterSequence, completionDetector(tool))[0];
  const start = buildStartDetector(tool);
  const unexpectedStart = start ? matchingEvents(timeline, afterSequence, start)[0] : undefined;
  const unexpected = unexpectedStart ?? unexpectedCompletion;
  if (unexpected) {
    throw new Error(
      `${tool} had build activity before the next edit; refusing stale completion at log ${unexpected.sequence}: ${unexpected.text}`,
    );
  }
}

export async function waitForCompletionAfterClose(
  timeline: LogTimeline,
  tool: ComparisonTool,
  checkpoint: number,
  edit: InPlaceEditWindow,
  timeoutMs: number,
): Promise<LogEvent> {
  const observed = matchingEvents(timeline, checkpoint, completionDetector(tool));
  const stale = observed.find((event) => event.atMs < edit.editStartedAt);
  if (stale) {
    throw new Error(`${tool} emitted a stale completion from before the edit: ${stale.text}`);
  }
  const beforeClose = observed.find((event) => event.atMs < edit.closedAt);
  if (beforeClose) {
    throw new Error(
      `${tool} reported completion before the edited source was closed: ${beforeClose.text}`,
    );
  }

  const nativeCompletion = completionDetector(tool);
  const completion = await timeline.waitFor(
    checkpoint,
    (event) => event.atMs >= edit.closedAt && nativeCompletion(event),
    timeoutMs,
  );
  const start = buildStartDetector(tool);
  if (start) {
    const startedAfterEdit = timeline
      .eventsAfter(checkpoint)
      .some(
        (event) =>
          event.sequence < completion.sequence && event.atMs >= edit.editStartedAt && start(event),
      );
    if (!startedAfterEdit) {
      throw new Error(`${tool} completion had no rebuild start after the measured edit`);
    }
  }
  return completion;
}

function targetRoute(corpus: ComparisonCorpus): string {
  const note = corpus.notes.find((candidate) => candidate.id === corpus.mutationNoteId);
  if (!note) throw new Error("comparison corpus mutation route is missing");
  return note.route;
}

function rootMarker(corpus: ComparisonCorpus): string {
  const note = corpus.notes.find((candidate) => candidate.route === "/");
  if (!note) throw new Error("comparison corpus root marker is missing");
  return note.marker;
}

async function validateDocusaurusProductionOutput(
  project: ComparisonProject,
  installation: Installation,
  finalVariant: "a" | "b",
  options: DevelopmentRunnerOptions,
): Promise<SemanticPageValidation> {
  await rm(project.outputDirectory, { force: true, recursive: true });
  const result = await superviseCommand(
    {
      args: ["build", ".", "--out-dir", project.outputDirectory],
      cwd: project.root,
      env: {
        ...developmentEnvironment(project.root),
        HUGO_ENVIRONMENT: "production",
        NODE_ENV: "production",
      },
      executable: installation.executable,
    },
    { rssSampleIntervalMs: 100, timeoutMs: options.timeoutMs },
  );
  if (result.exitCode !== 0) {
    const details = (result.stderr || result.stdout).trim().slice(-8_000);
    throw new Error(
      `docusaurus untimed semantic production build failed (${result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`})${details ? `:\n${details}` : ""}`,
    );
  }
  return validateSemanticPages(project.outputDirectory, project.expectedPages, {
    expectedMarker:
      finalVariant === "b" ? project.mutation.expectedMarker : project.mutation.forbiddenMarker,
    forbiddenMarker:
      finalVariant === "b" ? project.mutation.forbiddenMarker : project.mutation.expectedMarker,
    sourcePath: project.mutation.path,
  });
}

async function runDevelopmentSession(
  runRoot: string,
  corpus: ComparisonCorpus,
  installation: Installation,
  options: DevelopmentRunnerOptions,
): Promise<DevelopmentResult> {
  const projectRoot = path.join(runRoot, `${corpus.pages}-${installation.tool}`);
  const project = await projectComparisonCorpus(corpus, installation.tool, projectRoot);
  await prepareToolProject(project, installation);
  const beforeBytes = Buffer.byteLength(project.mutation.before);
  const afterBytes = Buffer.byteLength(project.mutation.after);
  if (beforeBytes !== afterBytes) {
    throw new Error(
      `development variants must have equal UTF-8 length (${beforeBytes} !== ${afterBytes})`,
    );
  }
  const host = "127.0.0.1";
  const port = await reservePort(host);
  let websocketPort = await reservePort(host);
  while (websocketPort === port) websocketPort = await reservePort(host);
  const command = serverCommand(project, installation, host, port, websocketPort);
  const process = new PersistentDevelopmentProcess(command, options.rssSampleIntervalMs);
  const rawSamples: DevelopmentSample[] = [];
  const warmupWallMs: number[] = [];
  const baseUrl = `http://${host}:${port}`;
  const mutationUrl = new URL(targetRoute(corpus), baseUrl).toString();
  const rootUrl = new URL("/", baseUrl).toString();
  let finalVariant: "a" | "b" = "a";
  let semanticEvidence: SemanticEvidence | undefined;
  try {
    const ready = await process.timeline.waitFor(0, readyDetector(project.tool), options.timeoutMs);
    if (project.tool === "docusaurus") {
      await waitForHttpOk(mutationUrl, options.httpTimeoutMs);
    } else {
      await waitForHttpBody(
        mutationUrl,
        project.mutation.forbiddenMarker,
        project.mutation.expectedMarker,
        options.httpTimeoutMs,
      );
    }

    const iterations = options.warmups + options.samples;
    let buildBoundary = ready.sequence;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const warmup = iteration < options.warmups;
      if (project.tool === "hugo") {
        // Hugo's Fast Render rebuilds pages that have been requested by a client.
        await fetchText(mutationUrl, options.httpTimeoutMs);
      }
      assertNoPendingBuildActivity(process.timeline, project.tool, buildBoundary);
      const expectedCurrent =
        finalVariant === "b" ? project.mutation.after : project.mutation.before;
      const sourcePath = path.resolve(project.root, project.mutation.path);
      if ((await readFile(sourcePath, "utf8")) !== expectedCurrent) {
        throw new Error(`development source drifted before edit: ${project.mutation.path}`);
      }
      finalVariant = finalVariant === "a" ? "b" : "a";
      const contents = finalVariant === "b" ? project.mutation.after : project.mutation.before;
      let checkpoint = -1;
      const edit = await writeInPlaceAndClose(sourcePath, contents, () => {
        checkpoint = process.timeline.cursor();
        return performance.now();
      });
      const event = await waitForCompletionAfterClose(
        process.timeline,
        project.tool,
        checkpoint,
        edit,
        options.timeoutMs,
      );
      buildBoundary = event.sequence;
      const wallMs = event.atMs - edit.editStartedAt;
      if (warmup) {
        warmupWallMs.push(wallMs);
      } else {
        rawSamples.push({
          completionLine: event.text,
          sample: iteration - options.warmups + 1,
          variant: finalVariant,
          wallMs,
        });
      }
    }

    const finalRequired =
      finalVariant === "b" ? project.mutation.expectedMarker : project.mutation.forbiddenMarker;
    const finalForbidden =
      finalVariant === "b" ? project.mutation.forbiddenMarker : project.mutation.expectedMarker;
    if (project.tool === "docusaurus") {
      await waitForHttpOk(mutationUrl, options.httpTimeoutMs);
    } else {
      await waitForHttpBody(mutationUrl, finalRequired, finalForbidden, options.httpTimeoutMs);
      await waitForHttpBody(rootUrl, rootMarker(corpus), undefined, options.httpTimeoutMs);
      semanticEvidence = {
        browserVisibilityVerified: false,
        markers: [rootMarker(corpus), finalRequired],
        oracle: "http-body",
      };
    }
  } finally {
    await process.stop();
  }
  if (project.tool === "docusaurus") {
    const productionPages = await validateDocusaurusProductionOutput(
      project,
      installation,
      finalVariant,
      options,
    );
    semanticEvidence = {
      browserVisibilityVerified: false,
      markers: [
        rootMarker(corpus),
        finalVariant === "b" ? project.mutation.expectedMarker : project.mutation.forbiddenMarker,
      ],
      oracle: "production-output",
      productionPages,
    };
  }
  if (!semanticEvidence) throw new Error("development semantic validation did not run");
  const snapshot = process.snapshot();
  return {
    command: commandDescription(command, project, port, websocketPort),
    corpusSha256: corpus.sha256,
    metric: "edit-start-to-watcher-build-complete",
    pages: corpus.pages,
    peakProcessTreeRssBytes: snapshot.peakProcessTreeRssBytes,
    processTreeRssSamples: snapshot.processTreeRssSamples,
    projectManifestSha256: project.manifestSha256,
    rawSamples,
    semanticEvidence,
    tool: installation.tool,
    wallMs: summarize(rawSamples.map((sample) => sample.wallMs)),
    warmupWallMs,
  };
}

function developmentMarkdownReport(report: {
  metadata: {
    generatedAt: string;
    hardware: { cpu: string; logicalCpus: number; totalMemoryBytes: number };
    installations: Installation[];
    options: {
      pages: number[];
      rssSampleIntervalMs: number;
      samples: number;
      tools: ComparisonTool[];
      warmups: number;
    };
    runtime: { arch: string; node: string; platform: string; release: string };
    versionLock: FileIdentity & { recordedAt: string; schemaVersion: number };
  };
  results: DevelopmentResult[];
}): string {
  const lines = [
    "# Static-site generator persistent development comparison",
    "",
    `Generated: ${report.metadata.generatedAt}`,
    "",
    "Metric: **edit-start-to-watcher-build-complete**. The clock starts immediately before an equal-length positioned source write and stops after the file has been fsynced and closed, when the native generator reports its rebuild complete. It includes write/fsync/close, watcher delivery, polling when used, debounce, scheduling, and the generator rebuild. It excludes browser notification, reload, rendering, semantic validation, setup, and shutdown.",
    "",
    `Runtime: Node ${report.metadata.runtime.node}, ${report.metadata.runtime.platform} ${report.metadata.runtime.release}, ${report.metadata.runtime.arch}`,
    `Hardware: ${report.metadata.hardware.cpu}; ${report.metadata.hardware.logicalCpus} logical CPUs; ${formatBytes(report.metadata.hardware.totalMemoryBytes)} memory`,
    `Settings: ${report.metadata.options.samples} measured alternating edit(s), ${report.metadata.options.warmups} warmup edit(s), ${report.metadata.options.rssSampleIntervalMs} ms RSS sampling`,
    `Version lock: \`${report.metadata.versionLock.sha256}\` (schema ${report.metadata.versionLock.schemaVersion}, recorded ${report.metadata.versionLock.recordedAt})`,
    "",
    "Each tool runs one fresh native development server per corpus size. Hugo's edited route is requested before each edit so Fast Render includes it. MkDocs uses its default full clean rebuild (not `--dirtyreload`). Readiness requires the native ready log and an HTTP response. For Inkpath, Hugo, MkDocs, and Quartz, untimed HTTP body checks validate the final edited marker and an unchanged page. Docusaurus serves a client-rendered development shell, so its HTTP check is status-only and an untimed production build validates exact route output after shutdown. HMR and browser visibility are not verified for any tool. p95 uses nearest rank. Process-tree RSS is the highest sampled sum over the persistent server and descendants, so shared pages may be counted in more than one process.",
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
  lines.push(
    "",
    "## Timings",
    "",
    "| Pages | Tool | Median | p95 | Persistent process-tree peak RSS | RSS snapshots |",
    "| ---: | --- | ---: | ---: | ---: | ---: |",
  );
  for (const result of report.results) {
    lines.push(
      `| ${result.pages} | ${result.tool} | ${formatMilliseconds(result.wallMs.median)} ms | ${formatMilliseconds(result.wallMs.p95)} ms | ${formatBytes(result.peakProcessTreeRssBytes)} | ${result.processTreeRssSamples} |`,
    );
  }
  lines.push("", "## Raw samples", "");
  for (const result of report.results) {
    lines.push(
      `### ${result.pages} pages — ${result.tool}`,
      "",
      `Corpus: \`${result.corpusSha256}\`; projected source: \`${result.projectManifestSha256}\`; untimed semantic oracle: ${result.semanticEvidence.oracle}; markers: ${result.semanticEvidence.markers.map((marker) => `\`${marker}\``).join(", ")}; browser visibility verified: no.`,
      "",
      `Command: \`${escapeTable(result.command)}\``,
      "",
      "| Sample | Variant | Edit-start-to-complete | Completion log |",
      "| ---: | --- | ---: | --- |",
    );
    for (const sample of result.rawSamples) {
      lines.push(
        `| ${sample.sample} | ${sample.variant.toUpperCase()} | ${formatMilliseconds(sample.wallMs)} ms | \`${escapeTable(sample.completionLine)}\` |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function runDevelopmentComparison(options: DevelopmentRunnerOptions): Promise<{
  metadata: {
    generatedAt: string;
    hardware: { cpu: string; logicalCpus: number; totalMemoryBytes: number };
    installations: Installation[];
    options: {
      pages: number[];
      rssSampleIntervalMs: number;
      samples: number;
      tools: ComparisonTool[];
      warmups: number;
    };
    runtime: { arch: string; node: string; platform: string; release: string };
    versionLock: FileIdentity & { recordedAt: string; schemaVersion: number };
  };
  results: DevelopmentResult[];
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
      await prepareInstallation(
        tool,
        options.toolConfigurations[tool],
        versionLock,
        developmentEnvironment(),
      ),
    );
  }
  await mkdir(options.workRoot, { recursive: true });
  const runRoot = await mkdtemp(path.join(options.workRoot, "inkpath-comparison-dev-"));
  const results: DevelopmentResult[] = [];
  try {
    for (const pages of options.pages) {
      progress(options, `Preparing deterministic ${pages}-page development corpus...`);
      const corpus = generateComparisonCorpus({ pages });
      for (const installation of installations) {
        progress(options, `Benchmarking ${installation.tool}: ${pages} pages, persistent dev...`);
        results.push(await runDevelopmentSession(runRoot, corpus, installation, options));
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
  const parsed = parseDevelopmentArguments(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(help);
    return;
  }
  const report = await runDevelopmentComparison(parsed);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = developmentMarkdownReport(report);
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
