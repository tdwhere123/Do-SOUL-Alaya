import type { QaDeliveredCandidate } from "./qa-harness.js";

// Deterministic support packer: after the LLM filter picks the "obviously
// relevant" memories, neighbouring turns (same session/source, nearby dates)
// often hold the date, number, or before/after value the answer needs. This
// expands the selected anchors with same-session neighbours from the wide pool,
// dedupes by object id, and caps by a per-question-type budget. No LLM.

function supportPackBudgetFor(questionType: string): number {
  switch (questionType) {
    case "temporal-reasoning":
      return 8;
    case "knowledge-update":
      return 10;
    case "multi-session":
    case "locomo-aggregation":
      return 14;
    default:
      // factual / preference / single-hop
      return 6;
  }
}

export function buildQaSupportPack(params: {
  readonly questionType: string;
  readonly selected: readonly QaDeliveredCandidate[];
  readonly widePool: readonly QaDeliveredCandidate[];
  readonly supportPool?: readonly QaDeliveredCandidate[];
  readonly maxDeliver: number;
}): QaDeliveredCandidate[] {
  const budget = Math.min(params.maxDeliver, supportPackBudgetFor(params.questionType));
  const result: QaDeliveredCandidate[] = [];
  const seen = new Set<string>();
  const candidateKey = (candidate: QaDeliveredCandidate): string =>
    `${candidate.objectKind ?? "memory_entry"}:${candidate.objectId}`;
  const add = (candidate: QaDeliveredCandidate): void => {
    const key = candidateKey(candidate);
    if (result.length >= budget || seen.has(key)) return;
    seen.add(key);
    result.push(candidate);
  };

  // 1. The filter-selected anchors come first and are never dropped.
  for (const candidate of params.selected) add(candidate);

  // 2. Same-session neighbours of the anchors, in natural pool order.
  const anchorSessions = new Set(
    params.selected
      .map((candidate) => candidate.sessionId)
      .filter((session): session is string => typeof session === "string" && session.length > 0)
  );
  if (anchorSessions.size > 0) {
    for (const candidate of params.supportPool ?? params.widePool) {
      if (typeof candidate.sessionId === "string" && anchorSessions.has(candidate.sessionId)) {
        add(candidate);
      }
    }
  }

  // 3. Fill any remaining budget from the pool in order (cross-session diversity).
  for (const candidate of params.widePool) add(candidate);

  return result;
}
