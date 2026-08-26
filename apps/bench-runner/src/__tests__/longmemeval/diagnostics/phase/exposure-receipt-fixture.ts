import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { sealTreatmentExposureReceipt } from
  "../../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import type { QuestionStageRow } from
  "../../../../bench/diagnostics/stage-attribution/types.js";
import { notObservedPhaseLedger } from "./not-observed-ledger.js";

export const FIXTURE_CAPTURE_RECEIPT_DIGEST = `sha256:${"d".repeat(64)}`;

export function exposure(
  questionId: string,
  exposureStatus: "exposed" | "not_exercised" | "inconclusive",
  changed: boolean,
  outcome = {
    control: { stage: "waist_or_later" as const, hit_at_5: false },
    treatment: { stage: "waist_or_later" as const, hit_at_5: false }
  }
) {
  return sealTreatmentExposureReceipt({
    schema_version: 4 as const,
    kind: "cached_f3_treatment_exposure" as const,
    question_id: questionId,
    ranking_authority: "prefix_sk" as const,
    capture_receipt_digest: FIXTURE_CAPTURE_RECEIPT_DIGEST,
    evidence_chain: { linked: exposureStatus !== "inconclusive" },
    control_non_exposure: {
      observed: true,
      formation_status: "unavailable",
      compatible_count: 0,
      composition_status: null,
      activation_status: null,
      activated_evidence_count: 0,
      candidate_attribution_count: 0,
      pure: true
    },
    formation: { status: exposureStatus === "exposed" ? "formed" : "unavailable" },
    compatible_evidence: { compatible_count: exposureStatus === "exposed" ? 1 : 0 },
    composition: {
      status: exposureStatus === "exposed" ? "composed" : "unavailable",
      solution_count: exposureStatus === "exposed" ? 1 : 0,
      binding_count: 0
    },
    activation: {
      status: exposureStatus === "exposed" ? "composed" : "unavailable",
      activated_evidence_count: exposureStatus === "exposed" ? 1 : 0
    },
    candidate_attribution: candidateAttribution(exposureStatus === "exposed"),
    membership_delta: {
      observed: true,
      changed,
      added_candidate_keys: changed ? ["candidate:f3"] : [],
      removed_candidate_keys: []
    },
    candidate_pool: { control_complete: true, treatment_complete: true },
    query_probe_delta: {
      observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: []
    },
    retrieval_channel_delta: { observed: false, changed: false, changed_channels: [] },
    outcome,
    product_phase_ledger: notObservedPhaseLedger(),
    exposure_status: exposureStatus
  });
}

export function diagnostic(
  questionId: string,
  candidateKeys: readonly string[],
  exposed = false
) {
  const digest = (seed: string) => `sha256:${seed.repeat(64)}`;
  const formation = {
    status: exposed ? "formed" : "unavailable",
    capture_digest: digest("1")
  };
  return {
    question_id: questionId,
    candidate_pool_complete: true,
    candidates: candidateKeys.map((candidate_key, index) => ({
      candidate_key,
      final_rank: index + 1,
      ...(exposed ? {
        selection_order: index + 1,
        admission_attempts: [{ admitted: true as const }]
      } : {})
    })),
    query_open_semantic_factor_formation: formation,
    open_semantic_factor_compatibility_trace: exposed ? {
      query_capture_digest: formation.capture_digest,
      matchable_evidence_count: 1,
      entries: [{ receipt: { status: "compatible" } }],
      trace_digest: digest("2")
    } : null,
    open_semantic_factor_composition: exposed ? {
      status: "composed",
      query_capture_digest: formation.capture_digest,
      compatibility_trace_digest: digest("2"),
      solution_count: 1,
      observed_binding_count: 0,
      bindings: [],
      receipt_digest: digest("3")
    } : null,
    open_semantic_factor_activation: exposed ? {
      status: "composed",
      composition_receipt_digest: digest("3"),
      entries: [{
        evidence_id: "e1", state: "observed", activation: 1,
        solution_count: 1, proposition_match_count: 1
      }]
    } : null,
    open_semantic_factor_candidate_activations: exposed ? candidateAttribution(true).entries : []
  } as never;
}

export function replaceCandidateReceipt(
  diagnosticValue: ReturnType<typeof diagnostic>,
  changes: Partial<ReturnType<typeof candidateAttribution>["entries"][number]["receipt"]>
) {
  const diagnosticRecord = diagnosticValue as Record<string, unknown>;
  const attribution = candidateAttribution(true);
  const receipt = { ...attribution.entries[0]!.receipt, ...changes };
  const { receipt_digest: _digest, ...body } = receipt;
  diagnosticRecord.open_semantic_factor_candidate_activations = [{
    candidate_key: "candidate:f3",
    receipt: { ...body, receipt_digest: digestRecallFieldIdentity(body) }
  }];
  return diagnosticRecord as never;
}

export function candidateAttribution(exposed: boolean) {
  if (!exposed) return { capture_receipt_digest: FIXTURE_CAPTURE_RECEIPT_DIGEST,
    entries: [], candidate_keys: [], activated_evidence_ids: [] };
  const body = {
    schema_version: 1 as const,
    operator_id: "open_semantic_factor_candidate_activation_v1" as const,
    state: "observed" as const,
    score: 1,
    evidence_ids: ["e1"],
    solution_count: 1,
    proposition_match_count: 1
  };
  return {
    capture_receipt_digest: FIXTURE_CAPTURE_RECEIPT_DIGEST,
    entries: [{
      candidate_key: "candidate:f3",
      receipt: { ...body, receipt_digest: digestRecallFieldIdentity(body) }
    }],
    candidate_keys: ["candidate:f3"],
    activated_evidence_ids: ["e1"]
  };
}

export function row(overrides: Partial<QuestionStageRow> & {
  readonly stage: QuestionStageRow["stage"];
  readonly proof: string;
}): QuestionStageRow {
  return {
    question_id: overrides.question_id ?? "q1",
    stage: overrides.stage,
    mechanism: overrides.mechanism ?? null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: overrides.miss_taxonomy ?? null,
    best_pool_rank: null,
    hit_at_5: overrides.hit_at_5 ?? false,
    proof: overrides.proof
  };
}
