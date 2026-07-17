import type { VerifiedShardEvidence } from "./shard-evidence-verifier.js";

export function canonicalizeVerifiedShards<T extends {
  readonly verifiedEvidence: VerifiedShardEvidence | null;
}>(loaded: readonly T[]): readonly T[] {
  if (!loaded.every((item) => item.verifiedEvidence !== null)) return loaded;
  const ordered = [...loaded].sort((left, right) =>
    left.verifiedEvidence!.execution.offset - right.verifiedEvidence!.execution.offset
  );
  if (ordered.some(
    (item) => item.verifiedEvidence!.execution.limit === null
  )) {
    throw new Error("merge refused: verified sharded executions require explicit limits");
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!.verifiedEvidence!.execution;
    const current = ordered[index]!.verifiedEvidence!.execution;
    if (current.offset !== previous.offset + previous.limit!) {
      throw new Error("merge refused: verified shard execution ranges are not contiguous");
    }
  }
  return ordered;
}
