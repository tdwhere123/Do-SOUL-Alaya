import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  buildRerankPoolIdf,
  RECALL_RERANK_BLEND,
  RECALL_RERANK_TOP_N,
  type RerankCandidate
} from "./recall-feature-rerank-model.js";
import { computeRerankFeatures } from "./recall-feature-rerank-scoring.js";

export function rerankTopN<T>(
  query: Readonly<RecallQueryProbes>,
  candidates: readonly RerankCandidate<T>[],
  topN: number = RECALL_RERANK_TOP_N
): readonly T[] {
  if (candidates.length === 0) {
    return Object.freeze([]);
  }
  const cut = resolveRerankCut(topN, candidates.length);
  if (cut <= 1) {
    return Object.freeze(candidates.map((candidate) => candidate.item));
  }
  if (!hasRerankQuerySignal(query)) {
    return Object.freeze(candidates.map((candidate) => candidate.item));
  }
  const head = candidates.slice(0, cut);
  const tail = candidates.slice(cut);
  const poolIdf = buildRerankPoolIdf(head.map((candidate) => candidate.text.content));
  const maxFusion = resolveHeadMaxFusionScore(head);
  const reordered = rankRerankHead(query, head, poolIdf, maxFusion);
  return appendRerankTail(reordered, tail);
}

function resolveRerankCut(topN: number, candidateCount: number): number {
  return Math.max(0, Math.min(topN, candidateCount));
}

function hasRerankQuerySignal(query: Readonly<RecallQueryProbes>): boolean {
  return (
    (query.normalized_query !== null && query.normalized_query.trim().length > 0) ||
    query.lexical_terms.length > 0 ||
    query.phrases.length > 0
  );
}

function resolveHeadMaxFusionScore<T>(
  head: readonly RerankCandidate<T>[]
): number {
  let maxFusion = Number.NEGATIVE_INFINITY;
  for (const candidate of head) {
    if (candidate.fusionScore > maxFusion) {
      maxFusion = candidate.fusionScore;
    }
  }
  return maxFusion;
}

function rankRerankHead<T>(
  query: Readonly<RecallQueryProbes>,
  head: readonly RerankCandidate<T>[],
  poolIdf: ReturnType<typeof buildRerankPoolIdf>,
  maxFusion: number
): readonly Readonly<{ readonly fusionIndex: number; readonly item: T; readonly blended: number }>[] {
  const scored = head.map((candidate, fusionIndex) => {
    const normalizedFusion = maxFusion > 0 ? candidate.fusionScore / maxFusion : 1;
    const lexicalScore = computeRerankFeatures(query, candidate.text, poolIdf).score;
    return Object.freeze({
      fusionIndex,
      item: candidate.item,
      blended:
        RECALL_RERANK_BLEND.fusion_weight * normalizedFusion +
        RECALL_RERANK_BLEND.rerank_weight * lexicalScore
    });
  });
  return [...scored].sort((left, right) => {
    const delta = right.blended - left.blended;
    return delta !== 0 ? delta : left.fusionIndex - right.fusionIndex;
  });
}

function appendRerankTail<T>(
  reordered: readonly Readonly<{ readonly item: T }>[],
  tail: readonly RerankCandidate<T>[]
): readonly T[] {
  return Object.freeze([
    ...reordered.map((entry) => entry.item),
    ...tail.map((candidate) => candidate.item)
  ]);
}
