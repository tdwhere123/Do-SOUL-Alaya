import { describe, expect, it } from "vitest";
import type {
  AttributedActivationPort,
  CausalUsagePort,
  EraseBarrierPort,
  FactorIncidencePort,
  ProjectionGenerationPort,
  ProofEffectPort,
  QueryConditionPort,
  SelectGammaPort,
  SourceAdmissionPort,
  StopCertificatePort
} from "../../../soul/field-contract/index.js";

describe("field-contract ports", () => {
  it("exposes method seams over protocol receipts", () => {
    const source: SourceAdmissionPort = {
      admit: (input) => ({
        record: {
          ...input,
          schema_version: 1,
          producer: "source_span_identity_v1",
          consumer: "projection_generation",
          identity: "sha256:" + "a".repeat(64),
          replay_rule: "idempotent_same_identity",
          failure_disposition: "fail_closed",
          governance_effect: "none",
          deletion_behavior: "retain_identity",
          content_digest: "sha256:" + "a".repeat(64),
          operator_id: "source_span_identity_v1"
        },
        spans: []
      })
    };
    const incidence: FactorIncidencePort = {
      recordIncidence: (input) => input,
      nominateJob: (input) => input
    };
    const generation: ProjectionGenerationPort = {
      snapshot: (input) => input,
      verify: (input) => input,
      activatePointer: (input) => input,
      pin: (input) => input
    };
    const condition: QueryConditionPort = {
      captureCondition: (input) => ({
        schema_version: 1,
        producer: "query_condition_v1",
        consumer: "attributed_activation",
        identity: "sha256:" + "a".repeat(64),
        replay_rule: "idempotent_same_identity",
        failure_disposition: "fail_closed",
        governance_effect: "none",
        deletion_behavior: "rebuildable",
        condition: input,
        generation_id: "sha256:" + "b".repeat(64),
        query_operator_id: "query_condition_v1",
        query_cache_key: "sha256:" + "c".repeat(64),
        recorded_at: input.effective_as_of
      })
    };
    const activation: AttributedActivationPort = {
      attribute: (input) => ({
        workspace_id: input.condition.workspace_id,
        generation_id: input.generation_id,
        condition_digest: input.identity,
        seed_ids: Object.freeze([]),
        opened_candidate_keys: Object.freeze([]),
        stop_disposition: "uncertified",
        frontier: "incomplete"
      })
    };
    const stop: StopCertificatePort = {
      certify: (input) => input
    };
    const proof: ProofEffectPort = {
      decide: (input) => ({
        schema_version: 1,
        producer: "proof_effect_v1",
        consumer: "governance",
        identity: "sha256:" + "a".repeat(64),
        replay_rule: "idempotent_same_identity",
        failure_disposition: "fail_closed",
        governance_effect: "policy_decision",
        deletion_behavior: "retain_identity",
        workspace_id: input.workspace_id,
        request_digest: "sha256:" + "a".repeat(64),
        action: input.action,
        target: input.target,
        scope: input.scope,
        effective_as_of: input.effective_as_of,
        decision: "deny",
        supporting_receipt_ids: input.supporting_receipt_ids,
        recorded_at: input.effective_as_of
      })
    };
    const usage: CausalUsagePort = {
      recordUsage: (input) => input
    };
    const select: SelectGammaPort = {
      select: (input) => ({
        selected_candidate_keys: input.eligible_candidate_keys
      })
    };
    const erase: EraseBarrierPort = {
      erase: (input) => input
    };

    expect(source.admit).toEqual(expect.any(Function));
    expect(incidence.nominateJob).toEqual(expect.any(Function));
    expect(generation.activatePointer).toEqual(expect.any(Function));
    expect(generation.pin).toEqual(expect.any(Function));
    expect(condition.captureCondition).toEqual(expect.any(Function));
    expect(activation.attribute).toEqual(expect.any(Function));
    expect(stop.certify).toEqual(expect.any(Function));
    expect(proof.decide).toEqual(expect.any(Function));
    expect(usage.recordUsage).toEqual(expect.any(Function));
    expect(select.select).toEqual(expect.any(Function));
    expect(erase.erase).toEqual(expect.any(Function));
  });
});
