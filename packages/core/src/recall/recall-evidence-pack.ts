import type {
  MemorySearchResult,
  RecallBudgetState,
  RecallCandidate,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import type { RecallResult } from "./recall-service-types.js";

export interface RecallEvidencePackInput {
  readonly fixture_id: string;
  readonly query: string;
  readonly result: Readonly<RecallResult>;
  readonly expected_object_ids: readonly string[];
  readonly delivery?: Readonly<{
    readonly delivery_id: string;
    readonly delivered_object_ids: readonly string[];
  }>;
  readonly usage?: Readonly<{
    readonly delivery_id: string;
    readonly used_object_ids: readonly string[];
    readonly skipped_object_ids?: readonly string[];
  }>;
}

export interface DaemonRecallEvidencePackInput {
  readonly fixture_id: string;
  readonly query: string;
  readonly results: readonly Readonly<MemorySearchResult>[];
  readonly expected_object_ids: readonly string[];
  readonly delivery?: RecallEvidencePackInput["delivery"];
  readonly usage?: RecallEvidencePackInput["usage"];
}

export interface RecallEvidencePackCandidate {
  readonly object_id: string;
  readonly source_channels: readonly string[];
  readonly score_factors: Readonly<RecallScoreFactors>;
  readonly budget_state: Readonly<RecallBudgetState> | null;
  readonly token_estimate: number;
  readonly evidence_pointers: readonly string[];
}

export interface RecallEvidencePackMetrics {
  readonly selected_count: number;
  readonly expected_hit_count: number;
  readonly factual_expected_hit: boolean;
  readonly coverage: number;
  readonly evidence_density: number;
  readonly redundancy: number;
  readonly token_footprint: number;
}

export interface RecallEvidencePack {
  readonly fixture_id: string;
  readonly query: string;
  readonly selected_object_ids: readonly string[];
  readonly candidates: readonly RecallEvidencePackCandidate[];
  readonly delivery_link: RecallEvidencePackInput["delivery"] | null;
  readonly usage_link: RecallEvidencePackInput["usage"] | null;
  readonly metrics: RecallEvidencePackMetrics;
}

export function buildRecallEvidencePack(input: RecallEvidencePackInput): Readonly<RecallEvidencePack> {
  return buildPack({
    fixture_id: input.fixture_id,
    query: input.query,
    expected_object_ids: input.expected_object_ids,
    candidates: input.result.candidates.map(fromRecallCandidate),
    delivery: input.delivery,
    usage: input.usage
  });
}

export function buildDaemonRecallEvidencePack(
  input: DaemonRecallEvidencePackInput
): Readonly<RecallEvidencePack> {
  return buildPack({
    fixture_id: input.fixture_id,
    query: input.query,
    expected_object_ids: input.expected_object_ids,
    candidates: input.results.map(fromMemorySearchResult),
    delivery: input.delivery,
    usage: input.usage
  });
}

function buildPack(input: Readonly<{
  readonly fixture_id: string;
  readonly query: string;
  readonly expected_object_ids: readonly string[];
  readonly candidates: readonly RecallEvidencePackCandidate[];
  readonly delivery?: RecallEvidencePackInput["delivery"];
  readonly usage?: RecallEvidencePackInput["usage"];
}>): Readonly<RecallEvidencePack> {
  const selectedObjectIds = Object.freeze(input.candidates.map((candidate) => candidate.object_id));
  const uniqueSelectedCount = new Set(selectedObjectIds).size;
  const expectedHits = input.expected_object_ids.filter((objectId) => selectedObjectIds.includes(objectId));
  const evidencePointerCount = input.candidates.reduce(
    (sum, candidate) => sum + candidate.evidence_pointers.length,
    0
  );
  const tokenFootprint = input.candidates.reduce((sum, candidate) => sum + candidate.token_estimate, 0);

  return Object.freeze({
    fixture_id: input.fixture_id,
    query: input.query,
    selected_object_ids: selectedObjectIds,
    candidates: Object.freeze(input.candidates),
    delivery_link: input.delivery ?? null,
    usage_link: input.usage ?? null,
    metrics: Object.freeze({
      selected_count: input.candidates.length,
      expected_hit_count: expectedHits.length,
      factual_expected_hit:
        input.expected_object_ids.length === 0
          ? input.candidates.length === 0
          : expectedHits.length > 0,
      coverage:
        input.expected_object_ids.length === 0
          ? (input.candidates.length === 0 ? 1 : 0)
          : roundMetric(expectedHits.length / input.expected_object_ids.length),
      evidence_density:
        input.candidates.length === 0
          ? 0
          : roundMetric(evidencePointerCount / input.candidates.length),
      redundancy:
        input.candidates.length === 0
          ? 0
          : roundMetric(1 - uniqueSelectedCount / input.candidates.length),
      token_footprint: tokenFootprint
    })
  });
}

function fromRecallCandidate(candidate: Readonly<RecallCandidate>): RecallEvidencePackCandidate {
  return Object.freeze({
    object_id: candidate.object_id,
    source_channels: candidate.source_channels ?? [],
    score_factors: candidate.score_factors ?? {
      activation: candidate.activation_score,
      relevance: candidate.relevance_score
    },
    budget_state: candidate.budget_state ?? null,
    token_estimate: candidate.token_estimate,
    evidence_pointers: Object.freeze([candidate.object_id])
  });
}

function fromMemorySearchResult(result: Readonly<MemorySearchResult>): RecallEvidencePackCandidate {
  return Object.freeze({
    object_id: result.object_id,
    source_channels: result.source_channels,
    score_factors: result.score_factors,
    budget_state: result.budget_state,
    token_estimate: result.budget_state.token_estimate,
    evidence_pointers: result.evidence_pointers
  });
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
