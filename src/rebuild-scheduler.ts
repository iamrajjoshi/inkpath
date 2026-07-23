import path from "node:path";

// Chokidar suppresses repeated `change` events for one path for 50 ms. Starting
// sooner can let the next editor write land inside that window after a fast
// rebuild, so keep the isolated quiet period just beyond it.
const DEFAULT_REBUILD_DEBOUNCE_MS = 55;
const DEFAULT_REBUILD_BURST_DEBOUNCE_MS = 75;
const DEFAULT_REBUILD_MAX_WAIT_MS = 90;

export type RebuildCallback = (changedPaths: readonly string[]) => Promise<void>;

export type ScheduleRebuildTimer = (callback: () => void, delayMs: number) => () => void;

export interface RebuildSchedulerOptions {
  /** Quiet period used for the first change in a batch. */
  debounceMs?: number;
  /** Quiet period used after another change arrives before the first timer fires. */
  burstDebounceMs?: number;
  /** Maximum time a stream of changes can postpone a rebuild. */
  maxWaitMs?: number;
  onError?: (error: unknown) => void;
  scheduleTimer?: ScheduleRebuildTimer;
}

function defaultScheduleTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeChangedPaths(changedPaths: string | readonly string[]): string[] {
  const paths = typeof changedPaths === "string" ? [changedPaths] : changedPaths;
  return paths.map((changedPath) => {
    if (!changedPath) throw new TypeError("changed paths must not be empty");
    return path.normalize(changedPath);
  });
}

function validateDelay(name: string, delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

/**
 * Coalesces file changes into deterministic, non-overlapping rebuilds.
 * A lone change uses the short quiet period. Further changes switch to the
 * burst quiet period without resetting the batch's maximum-wait deadline.
 *
 * Failed batches stay pending but are not retried in a tight loop. A later
 * change, an explicit flush, or close triggers one new attempt containing the
 * failed paths and any paths that arrived since the failure.
 */
export class RebuildScheduler {
  readonly #burstDebounceMs: number;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #rebuild: RebuildCallback;
  readonly #scheduleTimer: ScheduleRebuildTimer;
  readonly #pendingPaths = new Set<string>();

  #activeRun: Promise<void> | undefined;
  #cancelMaxWaitTimer: (() => void) | undefined;
  #cancelQuietTimer: (() => void) | undefined;
  #changeVersion = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #failureVersion: number | undefined;
  #hasFailure = false;
  #lastFailure: unknown;
  #maxWaitTimerVersion = 0;
  #quietTimerVersion = 0;
  #running = false;

  constructor(rebuild: RebuildCallback, options: RebuildSchedulerOptions = {}) {
    const debounceMs = options.debounceMs ?? DEFAULT_REBUILD_DEBOUNCE_MS;
    const burstDebounceMs =
      options.burstDebounceMs ??
      (options.debounceMs === undefined ? DEFAULT_REBUILD_BURST_DEBOUNCE_MS : debounceMs);
    const maxWaitMs =
      options.maxWaitMs ??
      (options.debounceMs === undefined
        ? DEFAULT_REBUILD_MAX_WAIT_MS
        : Math.max(debounceMs, burstDebounceMs));
    validateDelay("debounceMs", debounceMs);
    validateDelay("burstDebounceMs", burstDebounceMs);
    validateDelay("maxWaitMs", maxWaitMs);

    this.#burstDebounceMs = burstDebounceMs;
    this.#debounceMs = debounceMs;
    this.#maxWaitMs = maxWaitMs;
    this.#onError = options.onError;
    this.#rebuild = rebuild;
    this.#scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
  }

  add(changedPaths: string | readonly string[]): void {
    if (this.#closed) throw new Error("rebuild scheduler is closed");

    const normalizedPaths = normalizeChangedPaths(changedPaths);
    for (const changedPath of normalizedPaths) this.#pendingPaths.add(changedPath);
    if (normalizedPaths.length === 0) return;
    this.#changeVersion += 1;
    if (this.#running) return;

    this.#schedule();
  }

  async flush(): Promise<void> {
    if (this.#closed) throw new Error("rebuild scheduler is closed");
    await this.#flushPending();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;

    this.#closed = true;
    this.#cancelScheduledRun();
    this.#closePromise = this.#closePending();
    void this.#closePromise.catch(() => undefined);
    return this.#closePromise;
  }

  #schedule(): void {
    const isBurst = this.#cancelMaxWaitTimer !== undefined;
    this.#cancelQuietPeriod();

    const quietTimerVersion = this.#quietTimerVersion;
    this.#cancelQuietTimer = this.#scheduleTimer(
      () => {
        if (quietTimerVersion !== this.#quietTimerVersion) return;
        this.#triggerScheduledRun();
      },
      isBurst ? this.#burstDebounceMs : this.#debounceMs,
    );

    if (!isBurst) {
      const maxWaitTimerVersion = this.#maxWaitTimerVersion;
      this.#cancelMaxWaitTimer = this.#scheduleTimer(() => {
        if (maxWaitTimerVersion !== this.#maxWaitTimerVersion) return;
        this.#triggerScheduledRun();
      }, this.#maxWaitMs);
    }
  }

  #cancelQuietPeriod(): void {
    this.#quietTimerVersion += 1;
    const cancelTimer = this.#cancelQuietTimer;
    this.#cancelQuietTimer = undefined;
    cancelTimer?.();
  }

  #cancelScheduledRun(): void {
    this.#cancelQuietPeriod();
    this.#maxWaitTimerVersion += 1;
    const cancelMaxWaitTimer = this.#cancelMaxWaitTimer;
    this.#cancelMaxWaitTimer = undefined;
    cancelMaxWaitTimer?.();
  }

  #triggerScheduledRun(): void {
    this.#cancelScheduledRun();
    if (!this.#closed) void this.#startRun();
  }

  #startRun(): Promise<void> {
    if (this.#activeRun) return this.#activeRun;

    this.#running = true;
    const activeRun = this.#drain().finally(() => {
      if (this.#activeRun === activeRun) this.#activeRun = undefined;
      this.#running = false;
      if (!this.#closed && this.#pendingNeedsRun()) this.#schedule();
    });
    this.#activeRun = activeRun;

    // Timer-triggered builds have no caller awaiting them. Observe the promise
    // here so an unexpected scheduler error cannot become an unhandled rejection.
    void activeRun.catch(() => undefined);
    return activeRun;
  }

  async #drain(): Promise<void> {
    while (this.#pendingPaths.size > 0) {
      const batch = [...this.#pendingPaths].sort(comparePaths);
      const batchVersion = this.#changeVersion;
      this.#pendingPaths.clear();

      try {
        await this.#rebuild(batch);
        this.#failureVersion = undefined;
        this.#hasFailure = false;
        this.#lastFailure = undefined;
      } catch (error) {
        for (const changedPath of batch) this.#pendingPaths.add(changedPath);
        this.#failureVersion = batchVersion;
        this.#hasFailure = true;
        this.#lastFailure = error;
        this.#reportError(error);

        if (this.#changeVersion === batchVersion) return;
      }
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Error reporting must not interrupt rebuild recovery.
    }
  }

  #pendingNeedsRun(): boolean {
    return (
      this.#pendingPaths.size > 0 &&
      (!this.#hasFailure || this.#failureVersion !== this.#changeVersion)
    );
  }

  async #flushPending(): Promise<void> {
    this.#cancelScheduledRun();
    const activeRun =
      this.#activeRun ?? (this.#pendingPaths.size > 0 ? this.#startRun() : undefined);
    await activeRun;
    while (this.#pendingNeedsRun()) {
      this.#cancelScheduledRun();
      await this.#startRun();
    }

    if (this.#hasFailure && this.#pendingPaths.size > 0) throw this.#lastFailure;
  }

  async #closePending(): Promise<void> {
    try {
      const activeRun = this.#activeRun;
      if (activeRun) {
        await activeRun;
        while (this.#pendingNeedsRun()) await this.#startRun();
      } else if (this.#pendingPaths.size > 0) {
        await this.#startRun();
      }
      if (this.#hasFailure && this.#pendingPaths.size > 0) throw this.#lastFailure;
    } finally {
      this.#pendingPaths.clear();
    }
  }
}
