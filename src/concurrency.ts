import { availableParallelism } from "node:os";

export const DEFAULT_CONCURRENCY = Math.max(1, Math.min(availableParallelism(), 16));

type IndexedFailure = {
  error: unknown;
  index: number;
};

/**
 * Maps inputs concurrently while retaining their original order.
 *
 * Once a mapper fails, no more work is intentionally started. Work that has
 * already begun is allowed to settle so it cannot escape the caller's error
 * handling. If several started items fail, the lowest input index wins.
 */
export async function mapConcurrentOrdered<Input, Output>(
  inputs: readonly Input[],
  mapper: (input: Input, index: number) => Promise<Output>,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  if (!inputs.length) return [];

  const outputs: Output[] = [];
  const failures: IndexedFailure[] = [];
  let nextIndex = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) return;

      try {
        outputs[index] = await mapper(inputs[index] as Input, index);
      } catch (error) {
        failures.push({ error, index });
        stopped = true;
      }
    }
  };

  const workerCount = Math.min(concurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const failure = failures.sort((left, right) => left.index - right.index)[0];
  if (failure) throw failure.error;
  return outputs;
}
