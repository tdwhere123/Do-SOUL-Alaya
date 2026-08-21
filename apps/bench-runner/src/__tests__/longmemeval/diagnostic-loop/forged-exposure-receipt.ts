import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { sealTreatmentExposureReceipt } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { notObservedPhaseLedger } from "../diagnostics/phase/not-observed-ledger.js";

export function forgedExposureReceipt() {
  const activationBody = {
    schema_version: 1 as const,
    operator_id: "open_semantic_factor_candidate_activation_v1" as const,
    state: "observed" as const,
    score: 1,
    evidence_ids: ["e1"],
    solution_count: 1,
    proposition_match_count: 1
  };
  return sealTreatmentExposureReceipt({
    schema_version: 4,
    kind: "cached_f3_treatment_exposure",
    question_id: "forged",
    evidence_chain: { linked: true },
    control_non_exposure: {
      observed: true, formation_status: null, compatible_count: 0,
      composition_status: null, activation_status: null, activated_evidence_count: 0,
      candidate_attribution_count: 0, pure: true
    },
    formation: { status: "formed" },
    compatible_evidence: { compatible_count: 1 },
    composition: { status: "composed", solution_count: 1, binding_count: 0 },
    activation: { status: "composed", activated_evidence_count: 1 },
    candidate_attribution: {
      entries: [{
        candidate_key: "candidate:f3",
        receipt: { ...activationBody, receipt_digest: digestRecallFieldIdentity(activationBody) }
      }],
      candidate_keys: ["candidate:f3"],
      activated_evidence_ids: ["e1"]
    },
    membership_delta: {
      observed: true, changed: false, added_candidate_keys: [], removed_candidate_keys: []
    },
    candidate_pool: { control_complete: true, treatment_complete: true },
    query_probe_delta: {
      observed: false, changed: false, added_expanded_terms: [], removed_expanded_terms: []
    },
    retrieval_channel_delta: { observed: false, changed: false, changed_channels: [] },
    outcome: { control: { stage: "S5", hit_at_5: true }, treatment: { stage: "S5", hit_at_5: true } },
    product_phase_ledger: notObservedPhaseLedger(),
    exposure_status: "exposed"
  });
}
