// @ts-nocheck
import { sealTreatmentExposureReceipt } from
  "../../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import {
  GATE7_CANARY_Q1,
  GATE7_CANARY_Q2,
  GATE7_CANARY_Q3
} from "../../../../bench/diagnostics/stage-attribution/exposure/gate7-canary-ids.js";
import { candidateAttribution, exposure, row } from "./exposure-receipt-fixture.js";
import { notObservedPhaseLedger } from "./not-observed-ledger.js";

export function liveShapedPositiveReceipt(questionId = GATE7_CANARY_Q1) {
  return exposure(questionId, "exposed", true, {
    control: { stage: "S4", hit_at_5: false },
    treatment: { stage: "S5", hit_at_5: true }
  });
}

export function liveShapedNegativeReceipt(questionId: string) {
  return sealTreatmentExposureReceipt({
    schema_version: 4,
    kind: "cached_f3_treatment_exposure",
    question_id: questionId,
    ranking_authority: "d0_prefix",
    d0_receipt_digest: candidateAttribution(false).d0_receipt_digest,
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
      control: { stage: "S4", hit_at_5: false },
      treatment: { stage: "S4", hit_at_5: false }
    },
    product_phase_ledger: notObservedPhaseLedger(),
    exposure_status: "not_exercised"
  });
}

export function liveShapedCanaryReceipts() {
  return [
    liveShapedPositiveReceipt(GATE7_CANARY_Q1),
    liveShapedNegativeReceipt(GATE7_CANARY_Q2),
    liveShapedNegativeReceipt(GATE7_CANARY_Q3)
  ];
}

export function liveShapedCanaryRows() {
  return {
    control: [
      row({ question_id: GATE7_CANARY_Q1, stage: 5, proof: "budget_drop" }),
      row({ question_id: GATE7_CANARY_Q2, stage: 5, proof: "budget_drop" }),
      row({ question_id: GATE7_CANARY_Q3, stage: 5, proof: "budget_drop" })
    ],
    treatment: [
      row({
        question_id: GATE7_CANARY_Q1, stage: 7, hit_at_5: true, proof: "hit_at_5"
      }),
      row({ question_id: GATE7_CANARY_Q2, stage: 5, proof: "budget_drop" }),
      row({ question_id: GATE7_CANARY_Q3, stage: 5, proof: "budget_drop" })
    ]
  };
}
