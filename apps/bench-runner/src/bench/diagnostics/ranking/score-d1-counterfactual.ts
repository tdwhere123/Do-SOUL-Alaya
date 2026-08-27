import {
  replayD1FrozenCapture,
  type D1MissingnessCoverage,
  type D1ReplayMetrics,
  type D1ReplayResult
} from "@do-soul/alaya-core";
import { CANONICAL_CAPTURE_IDENTITY_DIGEST } from "@do-soul/alaya-protocol";
import { buildDiagnosticCandidateKey } from "../candidate-identity.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../schema/diagnostics-types.js";
import { streamRecallEvalQuestionDiagnostics } from
  "../stage-attribution/load-recall-eval-diagnostics.js";

export type D1CounterfactualRate = Readonly<{
  readonly hits: number;
  readonly denominator: number;
  readonly rate: number;
}>;

export type D1CounterfactualCaptureIdentity = Readonly<{
  readonly expected: typeof CANONICAL_CAPTURE_IDENTITY_DIGEST;
  readonly observed: readonly string[];
  readonly matches: boolean;
}>;

export type D1CounterfactualReport = Readonly<{
  readonly question_count: number;
  readonly answerable_count: number;
  readonly abstention_count: number;
  readonly skipped_missing_capture: number;
  readonly skipped_missing_proofs: number;
  readonly skipped_unmapped_gold: number;
  readonly parse_failure_count: number;
  readonly cycle_failure_count: number;
  readonly replayed_count: number;
  readonly production_any_at_5: D1CounterfactualRate;
  readonly d1_any_at_5: D1CounterfactualRate;
  readonly mean_blocked_pair_share: number;
  readonly mean_f1_over_h: number;
  readonly mean_max_g_cohort: number;
  readonly mean_deterministic_tail_share: number;
  readonly total_receipt_backed_dominance_edges: number;
  readonly missingness: D1MissingnessCoverage;
  readonly capture_identity: D1CounterfactualCaptureIdentity;
  readonly provider_not_requested: number;
}>;

type Accumulator = {
  question_count: number;
  answerable_count: number;
  abstention_count: number;
  skipped_missing_capture: number;
  skipped_missing_proofs: number;
  skipped_unmapped_gold: number;
  parse_failure_count: number;
  cycle_failure_count: number;
  replayed_count: number;
  production_hits: number;
  d1_hits: number;
  blocked_pair_share: number;
  f1_over_h: number;
  max_g_cohort: number;
  tail_share: number;
  dominance_edges: number;
  production_not_observed: number;
  legal_lane_envelopes: number;
  unbounded_lane_envelopes: number;
  inapplicable_lane_envelopes: number;
  capture_digests: Set<string>;
  provider_not_requested: number;
};

export async function evaluateRecallEvalGzipD1Counterfactual(
  artifactPath: string
): Promise<D1CounterfactualReport> {
  const acc = emptyAccumulator();
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    accumulateQuestion(acc, question);
  }
  return finishReport(acc);
}

function accumulateQuestion(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic
): void {
  acc.question_count += 1;
  if (question.provider_state === "provider_not_requested") {
    acc.provider_not_requested += 1;
  }
  const answerable = question.is_abstention !== true;
  if (answerable) acc.answerable_count += 1;
  else acc.abstention_count += 1;
  if (answerable && question.hit_at_5) acc.production_hits += 1;
  const receipt = capturedReceipt(question);
  if (receipt === null) {
    acc.skipped_missing_capture += 1;
    return;
  }
  noteCaptureDigest(acc, receipt.identity.digest);
  if (!hasCapturedProofs(question.lexical_bound_proofs)) {
    acc.skipped_missing_proofs += 1;
    return;
  }
  const goldKeys = goldCandidateKeys(question);
  if (goldKeys === null) {
    acc.skipped_unmapped_gold += 1;
    return;
  }
  applyReplay(acc, question, receipt, goldKeys, answerable);
}

function applyReplay(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic,
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>,
  goldKeys: readonly string[],
  answerable: boolean
): void {
  let replayed: D1ReplayResult;
  try {
    replayed = replayD1FrozenCapture({
      observations_by_candidate_key: receipt.observations_by_candidate_key,
      set_utilities: receipt.gamma.set_utilities,
      lexical_bound_proofs: question.lexical_bound_proofs,
      gold_keys: goldKeys
    });
  } catch (error) {
    if (isReplayInputFailure(error)) {
      acc.parse_failure_count += 1;
      return;
    }
    throw error;
  }
  if (replayed.kind !== "replayed") {
    acc.cycle_failure_count += 1;
    return;
  }
  recordMetrics(acc, replayed.metrics, answerable);
}

function recordMetrics(
  acc: Accumulator,
  metrics: D1ReplayMetrics,
  answerable: boolean
): void {
  acc.replayed_count += 1;
  acc.blocked_pair_share += metrics.blocked_pair_share;
  acc.f1_over_h += metrics.f1_over_h;
  acc.max_g_cohort += metrics.mean_max_g_cohort_size;
  acc.tail_share += metrics.deterministic_tail_share;
  acc.dominance_edges += metrics.receipt_backed_dominance_edges;
  acc.production_not_observed += metrics.missingness.production_not_observed;
  acc.legal_lane_envelopes += metrics.missingness.legal_lane_envelopes;
  acc.unbounded_lane_envelopes += metrics.missingness.unbounded_lane_envelopes;
  acc.inapplicable_lane_envelopes += metrics.missingness.inapplicable_lane_envelopes;
  if (answerable && metrics.any_at_5 === true) acc.d1_hits += 1;
}

function finishReport(acc: Accumulator): D1CounterfactualReport {
  const observed = [...acc.capture_digests].sort();
  const replayed = acc.replayed_count;
  return {
    question_count: acc.question_count,
    answerable_count: acc.answerable_count,
    abstention_count: acc.abstention_count,
    skipped_missing_capture: acc.skipped_missing_capture,
    skipped_missing_proofs: acc.skipped_missing_proofs,
    skipped_unmapped_gold: acc.skipped_unmapped_gold,
    parse_failure_count: acc.parse_failure_count,
    cycle_failure_count: acc.cycle_failure_count,
    replayed_count: replayed,
    production_any_at_5: rate(acc.production_hits, acc.answerable_count),
    d1_any_at_5: rate(acc.d1_hits, acc.answerable_count),
    mean_blocked_pair_share: mean(acc.blocked_pair_share, replayed),
    mean_f1_over_h: mean(acc.f1_over_h, replayed),
    mean_max_g_cohort: mean(acc.max_g_cohort, replayed),
    mean_deterministic_tail_share: mean(acc.tail_share, replayed),
    total_receipt_backed_dominance_edges: acc.dominance_edges,
    missingness: {
      production_not_observed: acc.production_not_observed,
      legal_lane_envelopes: acc.legal_lane_envelopes,
      unbounded_lane_envelopes: acc.unbounded_lane_envelopes,
      inapplicable_lane_envelopes: acc.inapplicable_lane_envelopes
    },
    capture_identity: {
      expected: CANONICAL_CAPTURE_IDENTITY_DIGEST,
      observed,
      matches: observed.length === 1 && observed[0] === CANONICAL_CAPTURE_IDENTITY_DIGEST
    },
    provider_not_requested: acc.provider_not_requested
  };
}

function capturedReceipt(
  question: LongMemEvalQuestionDiagnostic
): NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]> | null {
  const receipt = question.capture_receipt;
  if (receipt == null || receipt.execution.status !== "captured") return null;
  if (receipt.observations_by_candidate_key == null) return null;
  return receipt;
}

function hasCapturedProofs(proofs: unknown): boolean {
  if (!Array.isArray(proofs) || proofs.length === 0) return false;
  return proofs.some((row) =>
    row !== null && typeof row === "object" &&
    (row as { readonly status?: unknown }).status === "captured");
}

function goldCandidateKeys(
  question: LongMemEvalQuestionDiagnostic
): readonly string[] | null {
  const mapped = new Map<string, string>();
  for (const id of question.gold_memory_ids) {
    mapped.set(id, buildDiagnosticCandidateKey("workspace_local", "memory_entry", id));
  }
  for (const id of question.gold_evidence_ids) {
    mapped.set(id, buildDiagnosticCandidateKey("workspace_local", "evidence_capsule", id));
  }
  for (const gold of question.gold) {
    if (gold.object_kind !== "memory_entry" && gold.object_kind !== "evidence_capsule") {
      return null;
    }
    mapped.set(
      gold.object_id,
      buildDiagnosticCandidateKey("workspace_local", gold.object_kind, gold.object_id)
    );
  }
  for (const id of question.gold_object_ids ?? []) {
    if (mapped.has(id)) continue;
    const matches = question.candidates.filter((row) => row.object_id === id);
    if (matches.length !== 1) return null;
    mapped.set(id, matches[0]!.candidate_key);
  }
  return Object.freeze([...mapped.values()]);
}

function noteCaptureDigest(acc: Accumulator, digest: string): void {
  acc.capture_digests.add(digest);
}

function rate(hits: number, denominator: number): D1CounterfactualRate {
  return {
    hits,
    denominator,
    rate: denominator === 0 ? 0 : hits / denominator
  };
}

function mean(total: number, denominator: number): number {
  return denominator === 0 ? 0 : total / denominator;
}

function isReplayInputFailure(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && error.name === "ShadowContractError");
}

function emptyAccumulator(): Accumulator {
  return {
    question_count: 0,
    answerable_count: 0,
    abstention_count: 0,
    skipped_missing_capture: 0,
    skipped_missing_proofs: 0,
    skipped_unmapped_gold: 0,
    parse_failure_count: 0,
    cycle_failure_count: 0,
    replayed_count: 0,
    production_hits: 0,
    d1_hits: 0,
    blocked_pair_share: 0,
    f1_over_h: 0,
    max_g_cohort: 0,
    tail_share: 0,
    dominance_edges: 0,
    production_not_observed: 0,
    legal_lane_envelopes: 0,
    unbounded_lane_envelopes: 0,
    inapplicable_lane_envelopes: 0,
    capture_digests: new Set<string>(),
    provider_not_requested: 0
  };
}
