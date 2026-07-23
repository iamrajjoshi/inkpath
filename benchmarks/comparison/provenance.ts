import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJsonSha256,
  gitIdentity,
  treeIdentity,
  type FileIdentity,
  type GitIdentity,
  type TreeIdentity,
} from "../identity.js";
import type { ComparisonTool } from "./corpus.js";

export type { FileIdentity } from "../identity.js";

type InkpathLock = {
  source: string;
  version: string;
};

type HugoLock = {
  artifact: string;
  artifactSha256: string;
  executableSha256: string;
  release: string;
  version: string;
};

type MkDocsLock = {
  distributions: Record<string, string>;
  release: string;
  requirement: string;
  version: string;
};

type DocusaurusLock = {
  corePackageSha256: string;
  packageLockSha256: string;
  packages: Record<string, string>;
  release: string;
  version: string;
};

type QuartzLock = {
  commit: string;
  packageLockSha256: string;
  pluginCheckouts: Record<
    string,
    {
      commit: string;
      packageLockSha256: string;
    }
  >;
  pluginLockSha256: string;
  release: string;
  tag: string;
  version: string;
};

type ComparisonVersionLock = {
  $schema?: string;
  recordedAt: string;
  schemaVersion: 1;
  tools: {
    docusaurus: DocusaurusLock;
    hugo: HugoLock;
    inkpath: InkpathLock;
    mkdocs: MkDocsLock;
    quartz: QuartzLock;
  };
};

export type LoadedComparisonVersionLock = {
  data: ComparisonVersionLock;
  identity: FileIdentity;
};

type PythonDistribution = {
  name: string;
  normalizedName: string;
  version: string;
};

type PythonInventory = {
  distributions: PythonDistribution[];
  executable: FileIdentity;
  implementation: string;
  inventorySha256: string;
  version: string;
};

export type ToolProvenance = {
  artifact?: TreeIdentity & { root: string };
  files: FileIdentity[];
  git?: GitIdentity;
  identitySha256: string;
  pluginCheckouts?: Record<string, { git: GitIdentity; packageLock: FileIdentity }>;
  python?: PythonInventory;
  verifiedLockSha256: string;
};

type InspectProvenanceOptions = {
  executable: string;
  lock: LoadedComparisonVersionLock;
  reportedVersion: string;
  repositoryRoot: string;
  tool: ComparisonTool;
  toolRoot?: string;
};

type Inspection = {
  provenance: ToolProvenance;
  version: string;
};

type JsonObject = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function compareNamedEntries(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown],
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a string`);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function requiredCommit(value: unknown, label: string): string {
  const commit = requiredString(value, label);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`${label} must be a full Git commit`);
  return commit;
}

function requiredVersion(value: unknown, label: string): string {
  const version = requiredString(value, label);
  if (!VERSION_PATTERN.test(version)) throw new Error(`${label} must be a semantic version`);
  return version;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value).map(([name, version]) => {
    const exactVersion = requiredString(version, `${label}.${name}`);
    if (/\s/.test(exactVersion)) throw new Error(`${label}.${name} must not contain whitespace`);
    return [name, exactVersion];
  });
  if (!entries.length) throw new Error(`${label} must not be empty`);
  return Object.fromEntries(entries);
}

function semanticVersionMap(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(stringMap(value, label)).map(([name, version]) => [
      name,
      requiredVersion(version, `${label}.${name}`),
    ]),
  );
}

function quartzPluginCheckouts(value: unknown): QuartzLock["pluginCheckouts"] {
  if (!isObject(value)) throw new Error("quartz pluginCheckouts must be an object");
  const entries = Object.entries(value).map(([name, checkout]) => {
    if (!isObject(checkout)) throw new Error(`quartz pluginCheckouts.${name} must be an object`);
    return [
      name,
      {
        commit: requiredCommit(checkout.commit, `quartz pluginCheckouts.${name}.commit`),
        packageLockSha256: requiredSha256(
          checkout.packageLockSha256,
          `quartz pluginCheckouts.${name}.packageLockSha256`,
        ),
      },
    ];
  });
  if (!entries.length) throw new Error("quartz pluginCheckouts must not be empty");
  return Object.fromEntries(entries);
}

function parseVersionLock(value: unknown): ComparisonVersionLock {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.tools)) {
    throw new Error("comparison version lock must use schemaVersion 1");
  }
  const tools = value.tools;
  const inkpath = requiredObject(tools.inkpath, "comparison version lock inkpath");
  const hugo = requiredObject(tools.hugo, "comparison version lock hugo");
  const mkdocs = requiredObject(tools.mkdocs, "comparison version lock mkdocs");
  const docusaurus = requiredObject(tools.docusaurus, "comparison version lock docusaurus");
  const quartz = requiredObject(tools.quartz, "comparison version lock quartz");
  return {
    ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    recordedAt: requiredString(value.recordedAt, "comparison version lock recordedAt"),
    schemaVersion: 1,
    tools: {
      docusaurus: {
        corePackageSha256: requiredSha256(
          docusaurus.corePackageSha256,
          "docusaurus corePackageSha256",
        ),
        packageLockSha256: requiredSha256(
          docusaurus.packageLockSha256,
          "docusaurus packageLockSha256",
        ),
        packages: semanticVersionMap(docusaurus.packages, "docusaurus packages"),
        release: requiredString(docusaurus.release, "docusaurus release"),
        version: requiredVersion(docusaurus.version, "docusaurus version"),
      },
      hugo: {
        artifact: requiredString(hugo.artifact, "hugo artifact"),
        artifactSha256: requiredSha256(hugo.artifactSha256, "hugo artifactSha256"),
        executableSha256: requiredSha256(hugo.executableSha256, "hugo executableSha256"),
        release: requiredString(hugo.release, "hugo release"),
        version: requiredVersion(hugo.version, "hugo version"),
      },
      inkpath: {
        source: requiredString(inkpath.source, "inkpath source"),
        version: requiredVersion(inkpath.version, "inkpath version"),
      },
      mkdocs: {
        distributions: stringMap(mkdocs.distributions, "mkdocs distributions"),
        release: requiredString(mkdocs.release, "mkdocs release"),
        requirement: requiredString(mkdocs.requirement, "mkdocs requirement"),
        version: requiredVersion(mkdocs.version, "mkdocs version"),
      },
      quartz: {
        commit: requiredCommit(quartz.commit, "quartz commit"),
        packageLockSha256: requiredSha256(quartz.packageLockSha256, "quartz packageLockSha256"),
        pluginLockSha256: requiredSha256(quartz.pluginLockSha256, "quartz pluginLockSha256"),
        pluginCheckouts: quartzPluginCheckouts(quartz.pluginCheckouts),
        release: requiredString(quartz.release, "quartz release"),
        tag: requiredString(quartz.tag, "quartz tag"),
        version: requiredVersion(quartz.version, "quartz version"),
      },
    },
  };
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function fileIdentity(file: string): Promise<FileIdentity> {
  const absolute = await realpath(path.resolve(file));
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`expected a provenance file: ${absolute}`);
  return {
    bytes: metadata.size,
    path: absolute,
    sha256: await sha256File(absolute),
  };
}

export async function loadComparisonVersionLock(
  repositoryRoot: string,
): Promise<LoadedComparisonVersionLock> {
  const lockPath = path.join(repositoryRoot, "benchmarks", "comparison", "versions.lock.json");
  const identity = await fileIdentity(lockPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(identity.path, "utf8"));
  } catch (error) {
    throw new Error(`could not parse comparison version lock: ${identity.path}`, { cause: error });
  }
  return { data: parseVersionLock(parsed), identity };
}

export function normalizeDistributionName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, "-");
}

function exactVersion(tool: ComparisonTool, expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(
      `${tool} version mismatch: lock requires ${expected}, installation is ${actual}`,
    );
  }
}

function versionFromCommand(tool: ComparisonTool, output: string): string {
  const trimmed = output.trim();
  const match =
    tool === "hugo"
      ? /^hugo v?(\d+\.\d+\.\d+)(?:\s|-)/.exec(trimmed)
      : tool === "mkdocs"
        ? /\bversion (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/i.exec(trimmed)
        : /^(?:[^0-9]*)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(trimmed);
  if (!match?.[1])
    throw new Error(`could not parse ${tool} version from ${JSON.stringify(trimmed)}`);
  return match[1];
}

async function readJsonObject(file: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isObject(parsed)) throw new Error(`expected a JSON object: ${file}`);
  return parsed;
}

async function packageVersion(file: string): Promise<string> {
  const metadata = await readJsonObject(file);
  return requiredVersion(metadata.version, `${file} version`);
}

function assertDigest(identity: FileIdentity, expected: string, label: string): void {
  if (identity.sha256 !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: lock requires ${expected}, installation is ${identity.sha256}`,
    );
  }
}

export function assertCleanGitIdentity(identity: GitIdentity, label: string): void {
  if (identity.dirtyPaths.length) {
    throw new Error(`${label} has modified or untracked paths: ${identity.dirtyPaths.join(", ")}`);
  }
}

async function collectOutput(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${executable} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function pythonInventory(mkdocsExecutable: string): Promise<PythonInventory> {
  const launcher = await readFile(mkdocsExecutable, "utf8");
  const shebang = launcher.split(/\r?\n/, 1)[0];
  const configuredPython = shebang?.startsWith("#!") ? shebang.slice(2).trim() : "";
  if (!path.isAbsolute(configuredPython)) {
    throw new Error(`MkDocs executable must have an absolute Python shebang: ${mkdocsExecutable}`);
  }
  // Invoke the venv launcher path rather than its realpath: CPython discovers
  // pyvenv.cfg from argv[0], while the realpath points at uv's shared base
  // interpreter and would inventory the wrong environment.
  const python = path.resolve(configuredPython);
  const script = [
    "import importlib.metadata as metadata",
    "import json, platform",
    "items = sorted(({'name': d.metadata.get('Name') or '', 'version': d.version} for d in metadata.distributions()), key=lambda item: item['name'].lower())",
    "print(json.dumps({'implementation': platform.python_implementation(), 'version': platform.python_version(), 'distributions': items}, separators=(',', ':'))) ",
  ].join("; ");
  const output = await collectOutput(python, ["-c", script], {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: "",
  });
  const parsed: unknown = JSON.parse(output);
  if (!isObject(parsed) || !Array.isArray(parsed.distributions)) {
    throw new Error("pinned Python returned an invalid distribution inventory");
  }
  const distributions = parsed.distributions.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`invalid Python distribution at index ${index}`);
    const name = requiredString(entry.name, `Python distribution ${index} name`);
    return {
      name,
      normalizedName: normalizeDistributionName(name),
      version: stringMap({ [name]: entry.version }, "Python distribution")[name]!,
    };
  });
  return {
    distributions,
    executable: await fileIdentity(python),
    implementation: requiredString(parsed.implementation, "Python implementation"),
    inventorySha256: canonicalJsonSha256(
      distributions.map(({ normalizedName, version }) => ({ normalizedName, version })),
    ),
    version: requiredString(parsed.version, "Python version"),
  };
}

function verifyDistributionInventory(
  expected: Record<string, string>,
  inventory: PythonInventory,
): void {
  const actual: Record<string, string> = {};
  for (const distribution of inventory.distributions) {
    if (actual[distribution.normalizedName]) {
      throw new Error(`duplicate Python distribution: ${distribution.normalizedName}`);
    }
    actual[distribution.normalizedName] = distribution.version;
  }
  const normalizedExpected = Object.fromEntries(
    Object.entries(expected).map(([name, version]) => [normalizeDistributionName(name), version]),
  );
  if (
    JSON.stringify(Object.entries(actual).sort(compareNamedEntries)) !==
    JSON.stringify(Object.entries(normalizedExpected).sort(compareNamedEntries))
  ) {
    const expectedRows = Object.entries(normalizedExpected)
      .sort(compareNamedEntries)
      .map(([name, version]) => `${name}==${version}`);
    const actualRows = Object.entries(actual)
      .sort(compareNamedEntries)
      .map(([name, version]) => `${name}==${version}`);
    throw new Error(
      `MkDocs distribution inventory mismatch:\nexpected ${expectedRows.join(", ")}\nactual ${actualRows.join(", ")}`,
    );
  }
}

function nodeModulesRoot(toolRoot: string): { installRoot: string; modulesRoot: string } {
  if (path.basename(toolRoot) === "node_modules") {
    return { installRoot: path.dirname(toolRoot), modulesRoot: toolRoot };
  }
  return { installRoot: toolRoot, modulesRoot: path.join(toolRoot, "node_modules") };
}

function nodePackageManifest(modulesRoot: string, packageName: string): string {
  return path.join(modulesRoot, ...packageName.split("/"), "package.json");
}

async function inspectDocusaurus(
  root: string,
  expected: DocusaurusLock,
): Promise<{ files: FileIdentity[]; version: string }> {
  const { installRoot, modulesRoot } = nodeModulesRoot(root);
  const rootPackagePath = path.join(installRoot, "package.json");
  const packageLockPath = path.join(installRoot, "package-lock.json");
  const corePackagePath = nodePackageManifest(modulesRoot, "@docusaurus/core");
  const [rootPackage, packageLock, corePackage] = await Promise.all([
    fileIdentity(rootPackagePath),
    fileIdentity(packageLockPath),
    fileIdentity(corePackagePath),
  ]);
  assertDigest(packageLock, expected.packageLockSha256, "Docusaurus package-lock.json");
  assertDigest(corePackage, expected.corePackageSha256, "Docusaurus core package.json");
  for (const [packageName, expectedVersion] of Object.entries(expected.packages)) {
    exactVersion(
      "docusaurus",
      expectedVersion,
      await packageVersion(nodePackageManifest(modulesRoot, packageName)),
    );
  }
  const lockData = await readJsonObject(packageLockPath);
  if (lockData.lockfileVersion !== 3 || !isObject(lockData.packages)) {
    throw new Error("Docusaurus package-lock.json must use npm lockfileVersion 3");
  }
  const rootEntry = lockData.packages[""];
  if (!isObject(rootEntry) || !isObject(rootEntry.dependencies)) {
    throw new Error("Docusaurus package lock has no root dependency inventory");
  }
  for (const [packageName, expectedVersion] of Object.entries(expected.packages)) {
    exactVersion(
      "docusaurus",
      expectedVersion,
      requiredVersion(rootEntry.dependencies[packageName], `Docusaurus lock ${packageName}`),
    );
  }
  return {
    files: [rootPackage, packageLock, corePackage],
    version: await packageVersion(corePackagePath),
  };
}

async function inspectQuartz(
  root: string,
  expected: QuartzLock,
): Promise<{
  files: FileIdentity[];
  git: GitIdentity;
  pluginCheckouts: Record<string, { git: GitIdentity; packageLock: FileIdentity }>;
  version: string;
}> {
  const packagePath = path.join(root, "package.json");
  const packageLockPath = path.join(root, "package-lock.json");
  const pluginLockPath = path.join(root, "quartz.lock.json");
  const [packageIdentity, packageLock, pluginLock, sourceGit] = await Promise.all([
    fileIdentity(packagePath),
    fileIdentity(packageLockPath),
    fileIdentity(pluginLockPath),
    gitIdentity(root),
  ]);
  assertDigest(packageLock, expected.packageLockSha256, "Quartz package-lock.json");
  assertDigest(pluginLock, expected.pluginLockSha256, "Quartz quartz.lock.json");
  if (sourceGit.commit !== expected.commit) {
    throw new Error(
      `Quartz commit mismatch: lock requires ${expected.commit}, checkout is ${sourceGit.commit ?? "unknown"}`,
    );
  }
  assertCleanGitIdentity(sourceGit, "Quartz source checkout");
  const pluginLockData = await readJsonObject(pluginLockPath);
  if (!isObject(pluginLockData.plugins)) {
    throw new Error("Quartz quartz.lock.json has no plugin inventory");
  }
  const pluginCheckouts: Record<string, { git: GitIdentity; packageLock: FileIdentity }> = {};
  for (const [name, expectedCheckout] of Object.entries(expected.pluginCheckouts).sort(
    compareNamedEntries,
  )) {
    const lockedPlugin = pluginLockData.plugins[name];
    if (!isObject(lockedPlugin)) {
      throw new Error(`Quartz quartz.lock.json is missing benchmark plugin ${name}`);
    }
    const lockedCommit = requiredCommit(lockedPlugin.commit, `Quartz locked plugin ${name} commit`);
    if (lockedCommit !== expectedCheckout.commit) {
      throw new Error(
        `Quartz plugin ${name} lock mismatch: versions.lock requires ${expectedCheckout.commit}, quartz.lock.json has ${lockedCommit}`,
      );
    }
    const checkoutRoot = path.join(root, ".quartz", "plugins", name);
    const [checkoutGit, checkoutPackageLock] = await Promise.all([
      gitIdentity(checkoutRoot),
      fileIdentity(path.join(checkoutRoot, "package-lock.json")),
    ]);
    if (checkoutGit.commit !== expectedCheckout.commit) {
      throw new Error(
        `Quartz plugin ${name} commit mismatch: lock requires ${expectedCheckout.commit}, checkout is ${checkoutGit.commit ?? "unknown"}`,
      );
    }
    const unexpectedDirtyPaths = checkoutGit.dirtyPaths.filter(
      (dirtyPath) => dirtyPath !== "package-lock.json",
    );
    if (unexpectedDirtyPaths.length) {
      throw new Error(
        `Quartz plugin ${name} has modified source paths: ${unexpectedDirtyPaths.join(", ")}`,
      );
    }
    assertDigest(
      checkoutPackageLock,
      expectedCheckout.packageLockSha256,
      `Quartz plugin ${name} package-lock.json`,
    );
    pluginCheckouts[name] = { git: checkoutGit, packageLock: checkoutPackageLock };
  }
  return {
    files: [packageIdentity, packageLock, pluginLock],
    git: sourceGit,
    pluginCheckouts,
    version: await packageVersion(packagePath),
  };
}

function finalizeProvenance(
  lock: LoadedComparisonVersionLock,
  fields: Omit<ToolProvenance, "identitySha256" | "verifiedLockSha256">,
): ToolProvenance {
  const base = { ...fields, verifiedLockSha256: lock.identity.sha256 };
  return { ...base, identitySha256: canonicalJsonSha256(base) };
}

export async function inspectToolProvenance(
  options: InspectProvenanceOptions,
): Promise<Inspection> {
  const { executable, lock, reportedVersion, repositoryRoot, tool, toolRoot } = options;
  if (tool === "inkpath") {
    const expected = lock.data.tools.inkpath;
    const version = versionFromCommand(tool, reportedVersion);
    exactVersion(tool, expected.version, version);
    const artifactRoot = path.dirname(executable);
    const [artifact, sourceGit] = await Promise.all([
      treeIdentity(artifactRoot),
      gitIdentity(repositoryRoot),
    ]);
    return {
      provenance: finalizeProvenance(lock, {
        artifact: { ...artifact, root: artifactRoot },
        files: [],
        git: sourceGit,
      }),
      version,
    };
  }
  if (tool === "hugo") {
    const expected = lock.data.tools.hugo;
    const version = versionFromCommand(tool, reportedVersion);
    exactVersion(tool, expected.version, version);
    const binary = await fileIdentity(executable);
    assertDigest(binary, expected.executableSha256, "Hugo executable");
    return {
      provenance: finalizeProvenance(lock, { files: [binary] }),
      version,
    };
  }
  if (tool === "mkdocs") {
    const expected = lock.data.tools.mkdocs;
    const version = versionFromCommand(tool, reportedVersion);
    exactVersion(tool, expected.version, version);
    const python = await pythonInventory(executable);
    verifyDistributionInventory(expected.distributions, python);
    return {
      provenance: finalizeProvenance(lock, { files: [], python }),
      version,
    };
  }
  if (!toolRoot) throw new Error(`${tool} provenance needs a pinned tool root`);
  if (tool === "docusaurus") {
    const expected = lock.data.tools.docusaurus;
    const inspection = await inspectDocusaurus(toolRoot, expected);
    exactVersion(tool, expected.version, inspection.version);
    return {
      provenance: finalizeProvenance(lock, { files: inspection.files }),
      version: inspection.version,
    };
  }
  const expected = lock.data.tools.quartz;
  const inspection = await inspectQuartz(toolRoot, expected);
  exactVersion(tool, expected.version, inspection.version);
  return {
    provenance: finalizeProvenance(lock, {
      files: inspection.files,
      git: inspection.git,
      pluginCheckouts: inspection.pluginCheckouts,
    }),
    version: inspection.version,
  };
}

export async function assertArtifactIdentityUnchanged(provenance: ToolProvenance): Promise<void> {
  if (!provenance.artifact) return;
  const actual = await treeIdentity(provenance.artifact.root);
  const expected = provenance.artifact;
  if (
    actual.bytes !== expected.bytes ||
    actual.files !== expected.files ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error("Inkpath dist artifact changed while the comparison was running");
  }
}
