// @ts-nocheck
import { sealTreatmentExposureReceipt } from
  "../../../../diagnostics/stage-attribution/exposure/contract.js";
import {
  CANARY_Q1,
  CANARY_Q2,
  CANARY_Q3
} from "../../../../diagnostics/stage-attribution/exposure/canary-ids.js";
import { candidateAttribution, exposure, row } from "./exposure-receipt-fixture.js";
import { notObservedPhaseLedger } from "./not-observed-ledger.js";

export function liveShapedPositiveReceipt(questionId = CANARY_Q1) {
  return exposure(questionId, "exposed", true, {
    control: { stage: "waist_or_later", hit_at_5: false },
    treatment: { stage: "delivered_top5", hit_at_5: true }
  });
}

export function liveShapedNegativeReceipt(questionId: string) {
  return sealTreatmentExposureReceipt({
    schema_version: 4,
    kind: "cached_f3_treatment_exposure",
    question_id: questionId,
    ranking_authority: "prefix_sk",
    capture_receipt_digest: candidateAttribution(false).capture_receipt_digest,
    evidence_chain: { linked: true },
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
    formation: { status: "formed" },
    compatible_evidence: { compatible_count: 0 },
    composition: { status: "no_match", solution_count: 0, binding_count: 0 },
    activation: { status: "no_match", activated_evidence_count: 0 },
    candidate_attribution: candidateAttribution(false),
    membership_delta: {
      observed: true, changed: false, added_candidate_keys: [], removed_candidate_keys: []
    },
    candidate_pool: { control_complete: true, treatment_complete: true },
    query_probe_delta: {
      observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: []
    },
    retrieval_channel_delta: { observed: false, changed: false, changed_channels: [] },
    outcome: {
      control: { stage: "waist_or_later", hit_at_5: false },
      treatment: { stage: "waist_or_later", hit_at_5: false }
    },
    product_phase_ledger: notObservedPhaseLedger(),
    exposure_status: "not_exercised"
  });
}

export function liveShapedCanaryReceipts() {
  return [
    liveShapedPositiveReceipt(CANARY_Q1),
    liveShapedNegativeReceipt(CANARY_Q2),
    liveShapedNegativeReceipt(CANARY_Q3)
  ];
}

export function liveShapedCanaryRows() {
  return {
    control: [
      row({ question_id: CANARY_Q1, stage: "coverage_or_budget", proof: "budget_drop" }),
      row({ question_id: CANARY_Q2, stage: "coverage_or_budget", proof: "budget_drop" }),
      row({ question_id: CANARY_Q3, stage: "coverage_or_budget", proof: "budget_drop" })
    ],
    treatment: [
      row({
        question_id: CANARY_Q1, stage: "delivered_top5", hit_at_5: true, proof: "hit_at_5"
      }),
      row({ question_id: CANARY_Q2, stage: "coverage_or_budget", proof: "budget_drop" }),
      row({ question_id: CANARY_Q3, stage: "coverage_or_budget", proof: "budget_drop" })
    ]
  };
}
