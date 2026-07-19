type KnownKeyOptions = {
  hints?: Readonly<Record<string, string>>;
  scope: string;
  source: string;
};

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] ?? 0) +
        (left[leftIndex - 1]?.toLowerCase() === right[rightIndex - 1]?.toLowerCase() ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function suggestedKey(key: string, allowed: readonly string[]): string | undefined {
  const candidates = allowed
    .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.candidate.localeCompare(right.candidate),
    );
  const closest = candidates[0];
  if (!closest) return undefined;
  const maximumDistance = Math.min(3, Math.max(1, Math.floor(closest.candidate.length / 3)));
  return closest.distance <= maximumDistance ? closest.candidate : undefined;
}

export function assertKnownKeys(
  value: object,
  allowed: readonly string[],
  options: KnownKeyOptions,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort((left, right) => left.localeCompare(right))[0];
  if (!unknown) return;

  const hint = options.hints?.[unknown];
  const suggestion = hint ? undefined : suggestedKey(unknown, allowed);
  const action = hint ? ` ${hint}` : suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(
    `${options.source}: unknown ${options.scope} key "${unknown}".${action} Supported ${options.scope} keys: ${allowed.join(", ")}.`,
  );
}
