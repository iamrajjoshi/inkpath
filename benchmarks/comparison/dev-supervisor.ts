import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ComparisonTool } from "./corpus.js";
import {
  appendBounded,
  commandInvocation,
  delay,
  processTreeRssBytes,
  signalProcessTree,
  type CommandSpec,
} from "./supervisor.js";

const MAX_CAPTURE_BYTES = 512 * 1024;
const FORCE_KILL_AFTER_MS = 5_000;
const ESCAPE = String.fromCodePoint(27);
const BELL = String.fromCodePoint(7);
const ANSI_OSC = new RegExp(`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`, "g");
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|[@-_])`, "g");

export type LogStream = "stderr" | "stdout";

export type LogEvent = {
  atMs: number;
  sequence: number;
  stream: LogStream;
  text: string;
};

export type LogDetector = (event: LogEvent) => boolean;

type TimelineWaiter = {
  afterSequence: number;
  detector: LogDetector;
  reject: (error: Error) => void;
  resolve: (event: LogEvent) => void;
  timeout: NodeJS.Timeout;
};

export function stripAnsi(value: string): string {
  // Covers CSI colour/progress sequences and OSC terminal-title sequences.
  return value.replaceAll(ANSI_OSC, "").replaceAll(ANSI_SEQUENCE, "");
}

/**
 * A timestamped, chunk-safe line stream. Both stdout and stderr feed the same
 * monotonically ordered timeline so a checkpoint can be taken immediately
 * before a source edit.
 */
export class LogTimeline {
  private closedError: Error | undefined;
  private readonly events: LogEvent[] = [];
  private readonly fragments: Record<LogStream, string> = { stderr: "", stdout: "" };
  private readonly waiters = new Set<TimelineWaiter>();

  cursor(): number {
    return this.events.length;
  }

  eventsAfter(sequence: number): readonly LogEvent[] {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("log checkpoint must be a non-negative integer");
    }
    return this.events.filter((event) => event.sequence > sequence);
  }

  feed(stream: LogStream, chunk: string, atMs = performance.now()): void {
    let buffered = this.fragments[stream] + chunk;
    while (true) {
      const separator = buffered.search(/[\r\n]/);
      if (separator === -1) break;
      const separatorWidth =
        buffered[separator] === "\r" && buffered[separator + 1] === "\n" ? 2 : 1;
      this.emit(stream, buffered.slice(0, separator), atMs);
      buffered = buffered.slice(separator + separatorWidth);
    }
    this.fragments[stream] = buffered;
  }

  flush(stream: LogStream, atMs = performance.now()): void {
    const fragment = this.fragments[stream];
    this.fragments[stream] = "";
    if (fragment) this.emit(stream, fragment, atMs);
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.flush("stdout");
    this.flush("stderr");
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  waitFor(afterSequence: number, detector: LogDetector, timeoutMs: number): Promise<LogEvent> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      return Promise.reject(new Error("log checkpoint must be a non-negative integer"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error("log wait timeout must be at least 1 ms"));
    }
    for (const event of this.events) {
      if (event.sequence > afterSequence && detector(event)) return Promise.resolve(event);
    }
    if (this.closedError) return Promise.reject(this.closedError);

    return new Promise((resolve, reject) => {
      const waiter: TimelineWaiter = {
        afterSequence,
        detector,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`timed out after ${timeoutMs} ms waiting for generator log output`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private emit(stream: LogStream, rawText: string, atMs: number): void {
    const text = stripAnsi(rawText).trimEnd();
    const event = { atMs, sequence: this.events.length + 1, stream, text };
    this.events.push(event);
    for (const waiter of this.waiters) {
      if (event.sequence <= waiter.afterSequence || !waiter.detector(event)) continue;
      clearTimeout(waiter.timeout);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}

export function readyDetector(tool: ComparisonTool): LogDetector {
  const pattern: Record<ComparisonTool, RegExp> = {
    docusaurus: /\bClient:\s*Compiled successfully\b/i,
    hugo: /\bWeb Server is available\b/i,
    inkpath: /\bInkpath is serving\b/,
    mkdocs: /\bServing on\b/i,
    quartz: /\bStarted a Quartz server listening at\b/i,
  };
  return (event) => pattern[tool].test(event.text);
}

export function completionDetector(tool: ComparisonTool): LogDetector {
  if (tool === "mkdocs") {
    let built = false;
    return (event) => {
      if (/\bDocumentation built in\b/i.test(event.text)) built = true;
      return built && /\bReloading browsers\b/i.test(event.text);
    };
  }
  const pattern: Record<Exclude<ComparisonTool, "mkdocs">, RegExp> = {
    docusaurus: /\bClient:\s*Compiled successfully\b/i,
    hugo: /\bTotal in\s+\d+(?:\.\d+)?\s*ms\b/i,
    inkpath: /\bRebuilt\s+\d+\s+pages?\s+in\s+\d+(?:\.\d+)?ms\b/i,
    quartz: /\bDone rebuilding in\b/i,
  };
  return (event) => pattern[tool].test(event.text);
}

/** Native rebuild-start markers, when the generator emits a stable one. */
export function buildStartDetector(tool: ComparisonTool): LogDetector | undefined {
  const pattern: Partial<Record<ComparisonTool, RegExp>> = {
    hugo: /\bChange detected, rebuilding site\b/i,
    mkdocs: /\b(?:Detected file changes|Building documentation)\b/i,
    quartz: /\bDetected change, rebuilding\b/i,
  };
  const selected = pattern[tool];
  return selected ? (event) => selected.test(event.text) : undefined;
}

async function waitForExit(exitPromise: Promise<ExitResult>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exitPromise.then(() => true), timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

export type PersistentProcessSnapshot = {
  peakProcessTreeRssBytes: number;
  processTreeRssSamples: number;
  stderr: string;
  stdout: string;
};

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

export class PersistentDevelopmentProcess {
  readonly timeline = new LogTimeline();
  private exited = false;
  private peakProcessTreeRssBytes = 0;
  private processTreeRssSamples = 0;
  private stderr = "";
  private stdout = "";
  private readonly child: ChildProcess;
  private readonly exitPromise: Promise<ExitResult>;
  private readonly sampler: Promise<void>;

  constructor(command: CommandSpec, rssSampleIntervalMs: number) {
    if (!Number.isFinite(rssSampleIntervalMs) || rssSampleIntervalMs < 1) {
      throw new Error("RSS sample interval must be at least 1 ms");
    }
    const invocation = commandInvocation(command);
    const spawnOptions: SpawnOptions = {
      cwd: command.cwd,
      detached: true,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(invocation.executable, invocation.args, spawnOptions);
    this.child = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) throw new Error("persistent generator did not create output pipes");
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.stdout = appendBounded(this.stdout, chunk, MAX_CAPTURE_BYTES);
      this.timeline.feed("stdout", chunk);
    });
    stderr.on("data", (chunk: string) => {
      this.stderr = appendBounded(this.stderr, chunk, MAX_CAPTURE_BYTES);
      this.timeline.feed("stderr", chunk);
    });

    this.exitPromise = new Promise((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
        this.timeline.close(error);
      });
      child.once("close", (code, signal) => {
        this.exited = true;
        const detail = (this.stderr || this.stdout).trim().slice(-8_000);
        this.timeline.close(
          spawnError ??
            new Error(
              `generator exited (${signal ? `signal ${signal}` : `code ${String(code)}`})${detail ? `:\n${detail}` : ""}`,
            ),
        );
        resolve({ code, signal });
      });
    });

    this.sampler = (async () => {
      while (!this.exited) {
        if (child.pid) {
          const bytes = await processTreeRssBytes(child.pid);
          if (bytes !== undefined) {
            this.peakProcessTreeRssBytes = Math.max(this.peakProcessTreeRssBytes, bytes);
            this.processTreeRssSamples += 1;
          }
        }
        if (!this.exited) await delay(rssSampleIntervalMs);
      }
    })();
  }

  snapshot(): PersistentProcessSnapshot {
    return {
      peakProcessTreeRssBytes: this.peakProcessTreeRssBytes,
      processTreeRssSamples: this.processTreeRssSamples,
      stderr: this.stderr,
      stdout: this.stdout,
    };
  }

  async stop(): Promise<ExitResult> {
    if (!this.exited) {
      signalProcessTree(this.child, "SIGTERM");
      const graceful = await waitForExit(this.exitPromise, FORCE_KILL_AFTER_MS);
      if (!graceful && !this.exited) signalProcessTree(this.child, "SIGKILL");
    }
    const result = await this.exitPromise;
    await this.sampler;
    return result;
  }
}
