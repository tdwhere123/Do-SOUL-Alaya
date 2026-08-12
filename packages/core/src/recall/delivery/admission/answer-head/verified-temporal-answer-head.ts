import type { RecallQueryProbes } from
  "../../../query/recall-query-probes.js";
import type { RecallVerifiedUserAssertionContext } from
  "../../../query/recall-user-assertion-context.js";
import { isWorkspaceMemoryCandidate } from
  "../../../runtime/recall-service-helpers.js";
import {
  addAnswerHeadProtection,
  type AnswerHeadSelection
} from "../semantic-memory-refinement.js";
import type { AnswerHeadSourceCandidate } from "./answer-head-retention.js";

const TEMPORAL_HEAD_LIMIT = 5;
const CURRENT_CUE = /\bcurrently\b/iu;

export function retainVerifiedTemporalAnswerHead<
  T extends AnswerHeadSourceCandidate
>(params: Readonly<{
  readonly selection: AnswerHeadSelection<T>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly contextsByMemoryId: Readonly<
    Record<string, Readonly<RecallVerifiedUserAssertionContext>>
  >;
  readonly maxEntries: number;
  readonly selectDelivered: (candidates: readonly T[]) => readonly T[];
  readonly keyOf: (candidate: T) => string;
}>): AnswerHeadSelection<T> {
  if (!CURRENT_CUE.test(params.queryProbes.normalized_query ?? "")) {
    return params.selection;
  }
  const delivered = params.selectDelivered(params.selection.candidates);
  const rankLimit = Math.min(TEMPORAL_HEAD_LIMIT, params.maxEntries, delivered.length);
  const matches = delivered.flatMap((candidate, index) =>
    verifiedCurrentContext(candidate, params.contextsByMemoryId)
      ? [{ candidate, candidateKey: params.keyOf(candidate), index }]
      : []);
  if (matches.length !== 1) return params.selection;
  const selected = matches[0]!;
  if (selected.index < rankLimit) {
    return addAnswerHeadProtection(params.selection, selected, rankLimit);
  }
  const reordered = params.selection.candidates.filter((candidate) =>
    params.keyOf(candidate) !== selected.candidateKey);
  const targetKey = params.keyOf(delivered[rankLimit - 1]!);
  const targetIndex = reordered.findIndex((candidate) => params.keyOf(candidate) === targetKey);
  if (targetIndex < 0) return params.selection;
  reordered.splice(targetIndex, 0, selected.candidate);
  return addAnswerHeadProtection(Object.freeze({
    ...params.selection,
    candidates: Object.freeze(reordered)
  }), selected, rankLimit);
}

function verifiedCurrentContext<T extends AnswerHeadSourceCandidate>(
  candidate: T,
  contexts: Readonly<Record<string, Readonly<RecallVerifiedUserAssertionContext>>>
): boolean {
  if (!isWorkspaceMemoryCandidate(candidate)) return false;
  const context = contexts[candidate.entry.object_id];
  return context?.source_role === "user" &&
    context.assertion_text === candidate.entry.content.trim() &&
    CURRENT_CUE.test(context.user_context);
}
