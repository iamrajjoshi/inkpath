import assert from "node:assert/strict";
import test from "node:test";
import { RebuildScheduler, type ScheduleRebuildTimer } from "../src/rebuild-scheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function manualTimer(): {
  active: () => number;
  activeDelays: () => number[];
  fire: (delayMs?: number) => void;
  scheduled: () => number;
  scheduleTimer: ScheduleRebuildTimer;
} {
  const timers: Array<{ active: boolean; callback: () => void; delayMs: number }> = [];
  return {
    active: () => timers.filter((timer) => timer.active).length,
    activeDelays: () =>
      timers
        .filter((timer) => timer.active)
        .map((timer) => timer.delayMs)
        .sort((left, right) => left - right),
    fire: (delayMs) => {
      const timer = timers.find(
        (candidate) => candidate.active && (delayMs === undefined || candidate.delayMs === delayMs),
      );
      assert.ok(timer, "expected an active rebuild timer");
      timer.active = false;
      timer.callback();
    },
    scheduled: () => timers.length,
    scheduleTimer: (callback, delayMs) => {
      const timer = { active: true, callback, delayMs };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
  };
}

test("rebuild scheduler adapts its quiet period and deduplicates bursts", async () => {
  const timer = manualTimer();
  const batches: string[][] = [];
  const scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
    },
    { scheduleTimer: timer.scheduleTimer },
  );

  scheduler.add("notes/b.md");
  assert.deepEqual(timer.activeDelays(), [55, 90]);

  scheduler.add(["notes/a.md", "notes/section/../b.md"]);
  scheduler.add("notes/section/./c.md");

  assert.equal(timer.scheduled(), 4);
  assert.deepEqual(timer.activeDelays(), [75, 90]);
  timer.fire(75);
  await scheduler.flush();

  assert.deepEqual(batches, [["notes/a.md", "notes/b.md", "notes/section/c.md"]]);
  assert.equal(timer.active(), 0);
  await scheduler.close();
});

test("a non-resetting maximum wait bounds continuous change bursts", async () => {
  const timer = manualTimer();
  const batches: string[][] = [];
  const scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
    },
    {
      burstDebounceMs: 30,
      debounceMs: 10,
      maxWaitMs: 70,
      scheduleTimer: timer.scheduleTimer,
    },
  );

  scheduler.add("notes/a.md");
  assert.deepEqual(timer.activeDelays(), [10, 70]);
  scheduler.add("notes/b.md");
  scheduler.add("notes/c.md");
  scheduler.add("notes/d.md");

  assert.equal(timer.scheduled(), 5);
  assert.deepEqual(timer.activeDelays(), [30, 70]);
  timer.fire(70);
  await scheduler.flush();

  assert.deepEqual(batches, [["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md"]]);
  assert.equal(timer.active(), 0);
  await scheduler.close();
});

test("events during a rebuild queue one non-overlapping follow-up batch", async () => {
  const firstBuild = deferred();
  const batches: string[][] = [];
  let active = 0;
  let maximumActive = 0;
  const scheduler = new RebuildScheduler(async (changedPaths) => {
    batches.push([...changedPaths]);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (batches.length === 1) await firstBuild.promise;
    active -= 1;
  });

  scheduler.add("notes/b.md");
  const flushed = scheduler.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));

  scheduler.add("notes/c.md");
  scheduler.add(["notes/a.md", "notes/c.md"]);
  assert.deepEqual(batches, [["notes/b.md"]]);

  firstBuild.resolve();
  await flushed;
  assert.deepEqual(batches, [["notes/b.md"], ["notes/a.md", "notes/c.md"]]);
  assert.equal(maximumActive, 1);
  await scheduler.close();
});

test("an event in the run-completion microtask gap schedules a follow-up batch", async () => {
  const timer = manualTimer();
  const batches: string[][] = [];
  let scheduler: RebuildScheduler;
  scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
      if (batches.length === 1) {
        queueMicrotask(() => queueMicrotask(() => scheduler.add("notes/follow-up.md")));
      }
    },
    { scheduleTimer: timer.scheduleTimer },
  );

  scheduler.add("notes/initial.md");
  timer.fire();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(batches, [["notes/initial.md"]]);
  assert.equal(timer.active(), 2, "the follow-up event must retain live rebuild triggers");
  timer.fire(55);
  await scheduler.flush();

  assert.deepEqual(batches, [["notes/initial.md"], ["notes/follow-up.md"]]);
  await scheduler.close();
});

test("close drains an event added in the run-completion microtask gap", async () => {
  const timer = manualTimer();
  const batches: string[][] = [];
  let closing: Promise<void> | undefined;
  let scheduler: RebuildScheduler;
  scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
      if (batches.length === 1) {
        queueMicrotask(() =>
          queueMicrotask(() => {
            scheduler.add("notes/follow-up.md");
            closing = scheduler.close();
          }),
        );
      }
    },
    { scheduleTimer: timer.scheduleTimer },
  );

  scheduler.add("notes/initial.md");
  timer.fire();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(closing);
  await closing;
  assert.deepEqual(batches, [["notes/initial.md"], ["notes/follow-up.md"]]);
  assert.equal(timer.active(), 0);
});

test("a failed batch is retained and merged into a later edit", async () => {
  const timer = manualTimer();
  const failure = new Error("invalid note");
  const errors: unknown[] = [];
  const batches: string[][] = [];
  let attempt = 0;
  const scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
      attempt += 1;
      if (attempt === 1) throw failure;
    },
    {
      onError: (error) => errors.push(error),
      scheduleTimer: timer.scheduleTimer,
    },
  );

  scheduler.add("notes/broken.md");
  timer.fire();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
  assert.equal(timer.active(), 0, "a failure must not cause an automatic retry loop");

  scheduler.add("notes/fixed.md");
  await scheduler.flush();
  assert.deepEqual(batches, [["notes/broken.md"], ["notes/broken.md", "notes/fixed.md"]]);
  await scheduler.close();
});

test("close cancels timers, drains queued work, and prevents later changes", async () => {
  const timer = manualTimer();
  const batches: string[][] = [];
  const scheduler = new RebuildScheduler(
    async (changedPaths) => {
      batches.push([...changedPaths]);
    },
    { scheduleTimer: timer.scheduleTimer },
  );

  scheduler.add("notes/closing.md");
  assert.equal(timer.active(), 2);

  const firstClose = scheduler.close();
  assert.equal(timer.active(), 0);
  assert.equal(scheduler.close(), firstClose, "close should be idempotent");
  await firstClose;

  assert.deepEqual(batches, [["notes/closing.md"]]);
  assert.throws(() => scheduler.add("notes/late.md"), /scheduler is closed/);
  await assert.rejects(scheduler.flush(), /scheduler is closed/);
});

test("close reports a final rebuild failure without leaving an active timer", async () => {
  const timer = manualTimer();
  const failure = new Error("final rebuild failed");
  const scheduler = new RebuildScheduler(
    async () => {
      throw failure;
    },
    { scheduleTimer: timer.scheduleTimer },
  );

  scheduler.add("notes/broken-at-close.md");
  const closing = scheduler.close();

  assert.equal(timer.active(), 0);
  await assert.rejects(closing, failure);
  assert.equal(scheduler.close(), closing);
});
