import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 20;

export type CommandSpec = {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  executable: string;
};

export type SupervisedCommandResult = {
  exitCode: number | null;
  peakProcessTreeRssBytes: number;
  processTreeRssSamples: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  wallMs: number;
};

export type SupervisorOptions = {
  rssSampleIntervalMs?: number;
  timeoutMs?: number;
};

export function appendBounded(
  current: string,
  chunk: Buffer | string,
  maxBytes = MAX_CAPTURE_BYTES,
): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return next.slice(-maxBytes);
}

export function commandInvocation(command: CommandSpec): { args: string[]; executable: string } {
  const extension = path.extname(command.executable).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return {
      args: [command.executable, ...command.args],
      executable: process.execPath,
    };
  }
  return { args: command.args, executable: command.executable };
}

async function psOutput(processGroup: number): Promise<string> {
  return new Promise((resolve) => {
    const selection =
      process.platform === "linux"
        ? ["-o", "pid=,rss=", "--pgroup", String(processGroup)]
        : ["-o", "pid=,rss=", "-g", String(processGroup)];
    const child = spawn("/bin/ps", selection, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = appendBounded(output, chunk);
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? output : ""));
  });
}

/**
 * Sample the resident memory of a supervised process and its descendants. The
 * supervisor starts each command in a dedicated POSIX process group, letting
 * `ps` select only that tree instead of scanning every process on the host.
 * Both macOS and Linux report `ps` RSS in KiB. A snapshot is intentionally best
 * effort: a short-lived process may exit between spawning `ps` and reading it.
 */
export async function processTreeRssBytes(rootPid: number): Promise<number | undefined> {
  const rows = (await psOutput(rootPid)).split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        rssKiB: Number(match[2]),
      },
    ];
  });
  if (!rows.some((row) => row.pid === rootPid)) return undefined;
  return rows.reduce((total, row) => total + row.rssKiB * 1024, 0);
}

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // Supervised commands have their own POSIX process group, so this also
    // stops generator workers that outlive their immediate parent.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Run a pinned command while sampling the complete child process tree. */
export async function superviseCommand(
  command: CommandSpec,
  options: SupervisorOptions = {},
): Promise<SupervisedCommandResult> {
  const interval = options.rssSampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error("RSS sample interval must be at least 1 ms");
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    throw new Error("command timeout must be at least 1 ms");
  }

  const invocation = commandInvocation(command);
  const started = performance.now();
  const child = spawn(invocation.executable, invocation.args, {
    cwd: command.cwd,
    detached: true,
    env: command.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let spawnError: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = appendBounded(stderr, chunk);
  });

  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    wallMs: number;
  }>((resolve) => {
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      closed = true;
      resolve({ code, signal, wallMs: performance.now() - started });
    });
  });

  let peakProcessTreeRssBytes = 0;
  let processTreeRssSamples = 0;
  const sampler = (async () => {
    while (!closed) {
      if (child.pid) {
        const rss = await processTreeRssBytes(child.pid);
        if (rss !== undefined) {
          peakProcessTreeRssBytes = Math.max(peakProcessTreeRssBytes, rss);
          processTreeRssSamples += 1;
        }
      }
      if (!closed) await delay(interval);
    }
  })();

  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      signalProcessTree(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
      forceKill.unref();
    }, timeoutMs);
    timeout.unref();
  }

  const result = await completion;
  if (timeout) clearTimeout(timeout);
  if (forceKill) clearTimeout(forceKill);
  await sampler;
  if (spawnError) throw spawnError;
  return {
    exitCode: result.code,
    peakProcessTreeRssBytes,
    processTreeRssSamples,
    signal: result.signal,
    stderr,
    stdout,
    wallMs: result.wallMs,
  };
}
