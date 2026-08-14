export function symmetricDifferenceSize(
  captured: readonly string[],
  live: readonly string[]
): number {
  const capturedSet = new Set(captured);
  const liveSet = new Set(live);
  let count = 0;
  for (const key of capturedSet) if (!liveSet.has(key)) count += 1;
  for (const key of liveSet) if (!capturedSet.has(key)) count += 1;
  return count;
}

export function deltaTotal(
  deltas: Record<string, { gained: number; lost: number }>
): number {
  return Object.values(deltas).reduce(
    (sum, delta) => sum + delta.gained + delta.lost,
    0
  );
}

export function objectIdFromKey(candidateKey: string): string {
  return candidateKey.split(":").at(-1)!;
}
