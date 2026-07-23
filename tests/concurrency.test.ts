import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONCURRENCY, mapConcurrentOrdered } from "../src/concurrency.js";

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

test("ordered concurrent maps enforce their cap and preserve result order", async () => {
  const releases = Array.from({ length: 8 }, deferred);
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;

  const mapped = mapConcurrentOrdered(
    releases,
    async (release, index) => {
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await release.promise;
      active -= 1;
      return `result-${index}`;
    },
    3,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  releases[2]?.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases[1]?.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases[0]?.resolve();

  for (let index = 3; index < releases.length; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    releases[index]?.resolve();
  }

  assert.deepEqual(
    await mapped,
    releases.map((_, index) => `result-${index}`),
  );
  assert.equal(maximumActive, 3);
  assert.ok(DEFAULT_CONCURRENCY >= 1 && DEFAULT_CONCURRENCY <= 16);
});

test("ordered concurrent maps drain started work and report the lowest-index error", async () => {
  const lowRelease = deferred();
  const pendingRelease = deferred();
  const lowError = new Error("lowest-index failure");
  const highError = new Error("higher-index failure");
  const started: number[] = [];
  let rejection: unknown;

  const mapped = mapConcurrentOrdered(
    [0, 1, 2, 3],
    async (index) => {
      started.push(index);
      if (index === 0) {
        await lowRelease.promise;
        throw lowError;
      }
      if (index === 1) {
        await pendingRelease.promise;
        return index;
      }
      if (index === 2) throw highError;
      return index;
    },
    3,
  ).catch((error: unknown) => {
    rejection = error;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(rejection, undefined);

  lowRelease.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rejection, undefined, "the pending mapper must settle before rejection is reported");

  pendingRelease.resolve();
  await mapped;
  assert.equal(rejection, lowError);
  assert.deepEqual(started, [0, 1, 2]);
});

test("ordered concurrent maps reject invalid limits", async () => {
  await assert.rejects(
    mapConcurrentOrdered([], async () => undefined, 0),
    {
      message: "concurrency must be a positive integer",
      name: "RangeError",
    },
  );
});
