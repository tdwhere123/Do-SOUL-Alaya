import type {
  LongMemEvalQuestionDiagnostic,
  LongMemEvalQuestionMeasurementAxes,
  LongMemEvalReplayCandidate
} from "./diagnostics-types.js";
import {
  buildLongMemEvalSidecarKey,
  type LongMemEvalSidecarEntry
} from "./runner-scoring.js";

interface DeliveredMeasurementCandidate {
  readonly object_id: string;
  readonly object_kind?: string | null;
  readonly rank: number;
}

export interface QuestionMeasurementInput {
  readonly answer: string;
  readonly answerSessionIds: readonly string[];
  readonly sourceDatesBySession: ReadonlyMap<string, string>;
  readonly deliveredResults: readonly DeliveredMeasurementCandidate[];
  readonly candidates: readonly Pick<
    LongMemEvalReplayCandidate,
    "object_id" | "object_kind" | "candidate_key" | "answer_features"
  >[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly isAbstention: boolean;
  readonly evaluatorGoldMemoryIds?: readonly string[];
  readonly evaluatorHitAt5?: boolean;
}

type TopFiveCandidate = Readonly<{
  objectId: string;
  objectKind: "memory_entry" | "synthesis_capsule";
  rank: number;
  sidecar: LongMemEvalSidecarEntry | undefined;
  replay: QuestionMeasurementInput["candidates"][number] | undefined;
}>;

export function buildQuestionMeasurementAxes(
  input: QuestionMeasurementInput
): LongMemEvalQuestionMeasurementAxes {
  const topFive = joinTopFiveCandidates(input);
  return {
    answer_session_coverage_at_5: buildAnswerSessionCoverage(input, topFive),
    answer_literal_witness_lower_bound_at_5: buildLiteralWitnesses(input, topFive),
    source_timestamp_availability_at_5: buildTimestampAvailability(input, topFive),
    memory_temporal_projection_integrity_at_5:
      buildMemoryTemporalProjectionIntegrity(topFive),
    evaluator_identity_integrity_at_5:
      buildEvaluatorIdentityIntegrity(input, topFive),
    abstention: buildAbstentionMeasurement(input)
  };
}

export function attachQuestionMeasurementAxes(
  diagnostic: LongMemEvalQuestionDiagnostic,
  input: QuestionMeasurementInput
): LongMemEvalQuestionDiagnostic {
  const qualityAxes = buildQuestionMeasurementAxes({
    ...input,
    evaluatorGoldMemoryIds: diagnostic.gold_memory_ids,
    evaluatorHitAt5: diagnostic.hit_at_5
  });
  const cohortLedger = failClosedIdentityClassification(
    diagnostic.cohort_ledger,
    qualityAxes.evaluator_identity_integrity_at_5.status
  );
  return {
    ...diagnostic,
    ...failClosedDiagnosticClassification(
      qualityAxes.evaluator_identity_integrity_at_5.status
    ),
    quality_axes: qualityAxes,
    ...(cohortLedger === undefined ? {} : {
      cohort_ledger: { ...cohortLedger, quality_axes: qualityAxes }
    })
  };
}

function failClosedDiagnosticClassification(
  status: LongMemEvalQuestionMeasurementAxes["evaluator_identity_integrity_at_5"]["status"]
): Partial<Pick<LongMemEvalQuestionDiagnostic, "miss_classification" | "miss_taxonomy">> {
  if (status === "inconsistent") {
    return {
      miss_classification: "evaluator_identity_inconsistent",
      miss_taxonomy: "evaluation_or_gold_issue"
    };
  }
  if (status === "indeterminate") {
    return {
      miss_classification: "evaluator_identity_indeterminate",
      miss_taxonomy: "evaluation_or_gold_issue"
    };
  }
  return {};
}

function failClosedIdentityClassification(
  ledger: LongMemEvalQuestionDiagnostic["cohort_ledger"],
  status: LongMemEvalQuestionMeasurementAxes["evaluator_identity_integrity_at_5"]["status"]
): LongMemEvalQuestionDiagnostic["cohort_ledger"] {
  if (ledger === undefined || status === "consistent" || status === "not_applicable") {
    return ledger;
  }
  const suffix = status === "inconsistent" ? "inconsistency" : "indeterminate";
  return {
    ...ledger,
    measurement_status: "evaluator_identity_unscorable",
    retrieval_status: "not_applicable",
    evaluation_issue_reason: `evaluator_data_identity_${suffix}`,
    final_verdict: `evaluator_data_identity_${suffix}`
  };
}

function joinTopFiveCandidates(input: QuestionMeasurementInput): readonly TopFiveCandidate[] {
  const replayByIdentity = new Map(input.candidates.map((candidate) => [
    candidateIdentity(candidate.object_kind, candidate.object_id),
    candidate
  ]));
  return input.deliveredResults
    .filter((candidate) => candidate.rank <= 5)
    .map((candidate) => {
      const objectKind = normalizeObjectKind(candidate.object_kind);
      return {
        objectId: candidate.object_id,
        objectKind,
        rank: candidate.rank,
        sidecar: input.sidecar.get(buildLongMemEvalSidecarKey(objectKind, candidate.object_id)),
        replay: replayByIdentity.get(candidateIdentity(objectKind, candidate.object_id))
      };
    });
}

function buildAnswerSessionCoverage(
  input: QuestionMeasurementInput,
  topFive: readonly TopFiveCandidate[]
): LongMemEvalQuestionMeasurementAxes["answer_session_coverage_at_5"] {
  const targets = new Set(input.answerSessionIds);
  const applicable = !input.isAbstention && targets.size > 0;
  if (!applicable) {
    return { applicable: false, covered_count: 0, total_count: targets.size, ratio: null, full_coverage: false };
  }
  const covered = new Set(topFive
    .map((candidate) => candidate.sidecar?.sessionId)
    .filter((sessionId): sessionId is string => sessionId !== undefined && targets.has(sessionId)));
  return {
    applicable: true,
    covered_count: covered.size,
    total_count: targets.size,
    ratio: covered.size / targets.size,
    full_coverage: covered.size === targets.size
  };
}

function buildLiteralWitnesses(
  input: QuestionMeasurementInput,
  topFive: readonly TopFiveCandidate[]
): LongMemEvalQuestionMeasurementAxes["answer_literal_witness_lower_bound_at_5"] {
  const answer = normalizeLiteral(input.answer);
  const applicable = !input.isAbstention && answer.length > 0;
  const inspected = topFive.filter((candidate) => candidate.replay?.answer_features !== null &&
    candidate.replay?.answer_features !== undefined);
  const witnesses = applicable
    ? inspected.flatMap((candidate) => literalWitness(candidate, answer))
    : [];
  return {
    applicable,
    inspected_candidate_count: inspected.length,
    matched_candidate_count: new Set(witnesses.map((witness) =>
      candidateIdentity(witness.object_kind, witness.object_id)
    )).size,
    witnessed: witnesses.length > 0,
    witnesses
  };
}

function literalWitness(
  candidate: TopFiveCandidate,
  answer: string
): LongMemEvalQuestionMeasurementAxes["answer_literal_witness_lower_bound_at_5"]["witnesses"] {
  const features = candidate.replay?.answer_features;
  if (features === null || features === undefined) return [];
  const field = containsLiteral(features.content, answer)
    ? "content" as const
    : features.evidence_gist !== null && containsLiteral(features.evidence_gist, answer)
      ? "evidence_gist" as const
      : null;
  return field === null ? [] : [{
    object_id: candidate.objectId,
    object_kind: candidate.objectKind,
    rank: candidate.rank,
    field
  }];
}

function buildTimestampAvailability(
  input: QuestionMeasurementInput,
  topFive: readonly TopFiveCandidate[]
): LongMemEvalQuestionMeasurementAxes["source_timestamp_availability_at_5"] {
  const available = topFive.filter((candidate) => {
    const sessionId = candidate.sidecar?.sessionId;
    return sessionId !== undefined && hasText(input.sourceDatesBySession.get(sessionId));
  }).length;
  return {
    source: "dataset_session_timestamp_join",
    candidate_count: topFive.length,
    available_count: available,
    ratio: topFive.length === 0 ? null : available / topFive.length,
    all_available: topFive.length > 0 && available === topFive.length
  };
}

function buildMemoryTemporalProjectionIntegrity(
  topFive: readonly TopFiveCandidate[]
): LongMemEvalQuestionMeasurementAxes["memory_temporal_projection_integrity_at_5"] {
  const projected = topFive.filter(hasTemporalProjection);
  const complete = projected.filter(hasCompleteTemporalProvenance).length;
  return {
    source: "runtime_candidate_answer_features",
    candidate_count: topFive.length,
    projected_count: projected.length,
    provenance_complete_count: complete,
    integrity_ratio: projected.length === 0 ? null : complete / projected.length
  };
}

function hasTemporalProjection(candidate: TopFiveCandidate): boolean {
  const features = candidate.replay?.answer_features;
  if (features === null || features === undefined) return false;
  return [features.event_time_start, features.event_time_end, features.valid_from, features.valid_to]
    .some((value) => hasText(value ?? undefined));
}

function hasCompleteTemporalProvenance(candidate: TopFiveCandidate): boolean {
  const features = candidate.replay?.answer_features;
  return features !== null && features !== undefined &&
    features.projection_schema_version === 1 && features.time_precision != null &&
    features.time_source != null;
}

function buildEvaluatorIdentityIntegrity(
  input: QuestionMeasurementInput,
  topFive: readonly TopFiveCandidate[]
): LongMemEvalQuestionMeasurementAxes["evaluator_identity_integrity_at_5"] {
  const goldIds = new Set(input.evaluatorGoldMemoryIds ?? []);
  if (input.isAbstention || goldIds.size === 0) {
    return identityIntegrityResult(false, "not_applicable", 0, 0, 0, 0, 0);
  }
  const exactGold = topFive.filter((candidate) =>
    candidate.objectKind === "memory_entry" && goldIds.has(candidate.objectId)
  );
  const sessionSupport = exactGold.filter((candidate) =>
    input.answerSessionIds.includes(candidate.sidecar?.sessionId ?? "")
  ).length;
  const answer = normalizeLiteral(input.answer);
  const literalSupport = exactGold.filter((candidate) =>
    answer.length > 0 && literalWitness(candidate, answer).length > 0
  ).length;
  const topSessionSupport = topFive.filter((candidate) =>
    input.answerSessionIds.includes(candidate.sidecar?.sessionId ?? "")
  ).length;
  const topLiteralSupport = topFive.filter((candidate) =>
    answer.length > 0 && literalWitness(candidate, answer).length > 0
  ).length;
  const status = resolveIdentityStatus(
    input, exactGold, sessionSupport, literalSupport,
    topSessionSupport, topLiteralSupport
  );
  return identityIntegrityResult(
    true, status, exactGold.length, sessionSupport, literalSupport,
    topSessionSupport, topLiteralSupport
  );
}

function resolveIdentityStatus(
  input: QuestionMeasurementInput,
  exactGold: readonly TopFiveCandidate[],
  sessionSupport: number,
  literalSupport: number,
  topSessionSupport: number,
  topLiteralSupport: number
): "consistent" | "inconsistent" | "indeterminate" {
  const exactSupport = sessionSupport + literalSupport;
  if (input.evaluatorHitAt5 !== true) {
    return topSessionSupport + topLiteralSupport > 0 && exactSupport === 0
      ? "inconsistent"
      : "consistent";
  }
  if (exactGold.length === 0) return "inconsistent";
  if (exactSupport > 0) return "consistent";
  const sessionEvidence = input.answerSessionIds.length > 0 &&
    exactGold.every((candidate) => candidate.sidecar !== undefined);
  const literalEvidence = normalizeLiteral(input.answer).length > 0 &&
    exactGold.every((candidate) => candidate.replay?.answer_features != null);
  return sessionEvidence || literalEvidence ? "inconsistent" : "indeterminate";
}

function identityIntegrityResult(
  applicable: boolean,
  status: "not_applicable" | "consistent" | "inconsistent" | "indeterminate",
  exactGoldCount: number,
  sessionSupport: number,
  literalSupport: number,
  topSessionSupport: number,
  topLiteralSupport: number
): LongMemEvalQuestionMeasurementAxes["evaluator_identity_integrity_at_5"] {
  return {
    applicable,
    status,
    exact_gold_count: exactGoldCount,
    answer_session_supported_count: sessionSupport,
    literal_supported_count: literalSupport,
    top_five_answer_session_supported_count: topSessionSupport,
    top_five_literal_supported_count: topLiteralSupport
  };
}

function buildAbstentionMeasurement(
  input: QuestionMeasurementInput
): LongMemEvalQuestionMeasurementAxes["abstention"] {
  if (!input.isAbstention) return { applicable: false, status: "not_applicable" };
  return { applicable: true, status: "uncalibrated" };
}

function candidateIdentity(objectKind: string | null | undefined, objectId: string): string {
  return `${normalizeObjectKind(objectKind)}:${objectId}`;
}

function normalizeObjectKind(value: string | null | undefined) {
  return value === "synthesis_capsule" ? "synthesis_capsule" as const : "memory_entry" as const;
}

function normalizeLiteral(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsLiteral(value: string, normalizedLiteral: string): boolean {
  return ` ${normalizeLiteral(value)} `.includes(` ${normalizedLiteral} `);
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
