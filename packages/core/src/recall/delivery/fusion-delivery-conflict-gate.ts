import type { RecallFusionStream } from "../runtime/recall-service-types.js";
import { aggregateFamilyContributions } from "./fusion-delivery-families.js";

// Delivery any@5 budget: emb ranks inside this window are the protected ordinal head.
const DECISIVE_EMBEDDING_RANK_MAX = 5;
// Emb "support" for conflict refinement = decisive head plus one extra delivery page
// (same ordinal budget as any@5). Not a cohort cutoff: 2×DECISIVE is the near-miss
// neighborhood where emb still co-signals fusion; beyond it, emb presence alone is
// not support. (Deep-head 30 / fine-prune 200 are too wide — they would re-inert the gate.)
const FUSED_RESCUE_EMB_RANK_MAX = DECISIVE_EMBEDDING_RANK_MAX * 2;
// Tie-break only — requires a strict cosine gap past the first rank outside the budget.
const DECISIVE_EMBEDDING_COSINE_EPS = 1e-9;

// Conflict lanes ⊆ structural + graph families, plus evidence_fts (lexical member that piles
// with ESA). Would-outrank suppression zeros these for candidates outside the emb-head/rescue
// band that would otherwise clear the emb-head floor. Under bi-ON almost every pruned
// candidate has some emb rank — treating any emb hit as support left the gate inert.
export const CONFLICT_FUSION_STREAMS: ReadonlySet<RecallFusionStream> = Object.freeze(new Set<RecallFusionStream>([
  "path_expansion",
  "graph_expansion",
  "evidence_structural_agreement",
  "structural",
  "existing_score",
  "evidence_fts"
]));

export type ConflictGateContext = Readonly<{
  readonly embeddingStreamActive: boolean;
  readonly poolEmbeddingDecisive: boolean;
  readonly decisiveCandidateKeys: ReadonlySet<string>;
  readonly embeddingRankByKey: ReadonlyMap<string, number>;
}>;

export function isConflictFusionStream(stream: RecallFusionStream): boolean {
  return CONFLICT_FUSION_STREAMS.has(stream);
}

export function buildConflictGateContext(params: Readonly<{
  readonly candidateKeys: readonly string[];
  readonly embeddingRanks: ReadonlyMap<string, number> | undefined;
  readonly embeddingScores: Readonly<Record<string, number>> | undefined;
}>): ConflictGateContext {
  const embeddingRankByKey = params.embeddingRanks ?? new Map<string, number>();
  const embeddingStreamActive = embeddingRankByKey.size > 0;
  const decisiveCandidateKeys = selectDecisiveEmbeddingKeys({
    embeddingRankByKey,
    embeddingScores: params.embeddingScores,
    candidateKeys: params.candidateKeys
  });
  return Object.freeze({
    embeddingStreamActive,
    poolEmbeddingDecisive: embeddingStreamActive && decisiveCandidateKeys.size > 0,
    decisiveCandidateKeys,
    embeddingRankByKey
  });
}

export function zeroConflictStreamContributions<T extends Partial<Record<RecallFusionStream, number>>>(
  contributions: T
): T {
  const next = { ...contributions };
  for (const stream of CONFLICT_FUSION_STREAMS) {
    if (stream in next) {
      (next as Record<RecallFusionStream, number>)[stream] = 0;
    }
  }
  return next;
}

// When the emb head is decisive: conflict mass may refine inside the head and the fused-rescue
// band freely. Outside that band, candidates keep conflict mass only while their
// family-aggregated score stays ≤ the lowest decisive emb-head score — weak-emb + conflict
// piles may not clear the emb-top floor.
export function selectWouldOutrankSuppressedKeys(params: Readonly<{
  readonly gate: ConflictGateContext;
  readonly contributionsByKey: ReadonlyMap<string, Readonly<Partial<Record<RecallFusionStream, number>>>>;
}>): ReadonlySet<string> {
  if (!params.gate.poolEmbeddingDecisive) {
    return Object.freeze(new Set<string>());
  }
  const floor = decisiveEmbeddingFloor(params.gate, params.contributionsByKey);
  const suppressed = new Set<string>();
  for (const [candidateKey, contributions] of params.contributionsByKey) {
    if (params.gate.decisiveCandidateKeys.has(candidateKey)) {
      continue;
    }
    const embeddingRank = params.gate.embeddingRankByKey.get(candidateKey);
    // Decisive head + fused-rescue band keep conflict for mid-rank emb rescues.
    if (embeddingRank !== undefined && embeddingRank <= FUSED_RESCUE_EMB_RANK_MAX) {
      continue;
    }
    if (aggregateFamilyContributions(contributions) > floor) {
      suppressed.add(candidateKey);
    }
  }
  return Object.freeze(suppressed);
}

export function shouldSuppressConflictStreamContribution(params: Readonly<{
  readonly stream: RecallFusionStream;
  readonly candidateKey: string;
  readonly suppressedCandidateKeys: ReadonlySet<string>;
}>): boolean {
  return isConflictFusionStream(params.stream)
    && params.suppressedCandidateKeys.has(params.candidateKey);
}

function decisiveEmbeddingFloor(
  gate: ConflictGateContext,
  contributionsByKey: ReadonlyMap<string, Readonly<Partial<Record<RecallFusionStream, number>>>>
): number {
  let floor = Number.POSITIVE_INFINITY;
  for (const key of gate.decisiveCandidateKeys) {
    const contributions = contributionsByKey.get(key);
    const score = contributions === undefined ? 0 : aggregateFamilyContributions(contributions);
    if (score < floor) {
      floor = score;
    }
  }
  return Number.isFinite(floor) ? floor : 0;
}

function selectDecisiveEmbeddingKeys(params: Readonly<{
  readonly embeddingRankByKey: ReadonlyMap<string, number>;
  readonly embeddingScores: Readonly<Record<string, number>> | undefined;
  readonly candidateKeys: readonly string[];
}>): ReadonlySet<string> {
  if (params.embeddingRankByKey.size === 0) {
    return Object.freeze(new Set<string>());
  }
  const candidateKeySet = new Set(params.candidateKeys);
  const ranked = [...params.embeddingRankByKey.entries()]
    .filter(([key]) => candidateKeySet.has(key))
    .sort((left, right) => left[1] - right[1]);
  if (ranked.length === 0) {
    return Object.freeze(new Set<string>());
  }
  const insideBudget = ranked.filter(([, rank]) => rank <= DECISIVE_EMBEDDING_RANK_MAX);
  if (insideBudget.length === 0) {
    return Object.freeze(new Set<string>());
  }
  const outside = ranked.find(([, rank]) => rank === DECISIVE_EMBEDDING_RANK_MAX + 1);
  if (outside === undefined) {
    return Object.freeze(new Set<string>(insideBudget.map(([key]) => key)));
  }
  const hasCosines = insideBudget.some(([key]) => cosineFor(key, params.embeddingScores) > 0)
    || cosineFor(outside[0], params.embeddingScores) > 0;
  // No cosine surface → rank inside the delivery budget is the decisive predicate alone.
  if (!hasCosines) {
    return Object.freeze(new Set<string>(insideBudget.map(([key]) => key)));
  }
  const outsideScore = cosineFor(outside[0], params.embeddingScores);
  const decisive = insideBudget.filter(([key]) =>
    cosineFor(key, params.embeddingScores) >= outsideScore + DECISIVE_EMBEDDING_COSINE_EPS
  );
  return Object.freeze(new Set<string>(decisive.map(([key]) => key)));
}

function cosineFor(
  candidateKey: string,
  embeddingScores: Readonly<Record<string, number>> | undefined
): number {
  if (embeddingScores === undefined) {
    return 0;
  }
  // Candidate keys are `plane:kind:object_id`; scores are keyed by object_id.
  const objectId = candidateKey.includes(":")
    ? candidateKey.slice(candidateKey.lastIndexOf(":") + 1)
    : candidateKey;
  const score = embeddingScores[objectId] ?? embeddingScores[candidateKey];
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}
