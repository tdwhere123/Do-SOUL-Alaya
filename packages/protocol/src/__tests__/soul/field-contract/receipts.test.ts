import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AddressableSourceSpanSchema,
  CausalUsageReceiptSchema,
  EffectDecisionReceiptSchema,
  EffectRequestSchema,
  FIELD_STOP_CERTIFICATE_OPERATOR_ID,
  FieldStopCertificateReceiptSchema,
  ProjectionEraseBarrierSchema,
  QueryConditionReceiptSchema,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  classifyFieldValidTime,
  hashConditionDigest,
  hashContentDigest,
  hashEffectRequestDigest,
  hashQueryCacheKey,
  hashSourceRecordId
} from "../../../soul/field-contract/index.js";
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

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

const RECORDED_AT = "2026-08-16T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("field-contract receipts", () => {
  it("treats unknown valid time as soft-recallable, never hard-active", () => {
    expect(classifyFieldValidTime({
      valid_from: null,
      valid_to: null
    }, RECORDED_AT)).toBe("soft_recallable");
    expect(classifyFieldValidTime({
      valid_from: "2026-08-15T00:00:00.000Z",
      valid_to: "2026-08-17T00:00:00.000Z"
    }, RECORDED_AT)).toBe("hard_active");
    expect(SourceRecordIdentitySchema.parse(sourceRecord()).valid_from).toBeNull();
  });

  it("rejects erase tombstones that still carry content fields", () => {
    const tombstone = {
      schema_version: 1 as const,
      producer: "erase_barrier",
      consumer: "projection_generation",
      identity: DIGEST_A,
      replay_rule: "idempotent_same_identity" as const,
      failure_disposition: "fail_closed" as const,
      governance_effect: "tombstone" as const,
      deletion_behavior: "content_free_tombstone" as const,
      workspace_id: "workspace-1",
      barrier_id: "barrier-1",
      generation_id: null,
      subject_kind: "source_record" as const,
      subject_id: DIGEST_B,
      erased_at: RECORDED_AT
    };

    expect(ProjectionEraseBarrierSchema.parse(tombstone)).toEqual(tombstone);
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...tombstone,
      excerpt: "still secret"
    })).toThrow();
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...tombstone,
      payload: { text: "no" }
    })).toThrow();
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...tombstone,
      embedding: [0.1]
    })).toThrow();
    expect(() => ProjectionEraseBarrierSchema.parse({
      ...tombstone,
      factor_text: "token"
    })).toThrow();
  });

  it("requires half-open spans and content-free delivery usage", () => {
    expect(() => AddressableSourceSpanSchema.parse({
      ...spanFields(),
      start_offset: 8,
      end_offset: 3
    })).toThrow(/half-open/u);
    expect(() => CausalUsageReceiptSchema.parse({
      ...usageFields(),
      usage_kind: "delivery",
      weight: 0.4
    })).toThrow(/weight 0/u);
    expect(CausalUsageReceiptSchema.parse({
      ...usageFields(),
      usage_kind: "delivery",
      weight: 0
    }).weight).toBe(0);
  });

  it("binds query cache keys to generation, condition, and operator version", () => {
    const condition = {
      principal: "agent",
      authorized_scopes: ["workspace-1"],
      explicit_bridges: [],
      workspace_project: "project-a",
      effective_as_of: RECORDED_AT,
      query_task_factors: ["task"],
      governance_state: "open",
      activation_budget: 4,
      token_budget: 200,
      request_id: "req-ephemeral"
    };
    const receipt = QueryConditionReceiptSchema.parse({
      schema_version: 1,
      producer: "query_condition_v1",
      consumer: "attributed_activation",
      identity: hashConditionDigest(condition, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "none",
      deletion_behavior: "rebuildable",
      condition,
      generation_id: DIGEST_A,
      query_operator_version: "query_condition_v1",
      query_cache_key: hashQueryCacheKey({
        generation_id: DIGEST_A,
        condition_digest: hashConditionDigest(condition, sha256),
        query_operator_version: "query_condition_v1"
      }, sha256),
      recorded_at: RECORDED_AT
    });

    expect(receipt.identity).toBe(hashConditionDigest({
      ...condition,
      request_id: "other"
    }, sha256));
  });

  it("lifts an honest stop receipt without inventing a second selector", () => {
    const certified = FieldStopCertificateReceiptSchema.parse({
      schema_version: 1,
      producer: FIELD_STOP_CERTIFICATE_OPERATOR_ID,
      consumer: "select_gamma",
      identity: DIGEST_A,
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "audit_only",
      deletion_behavior: "rebuildable",
      operator_id: FIELD_STOP_CERTIFICATE_OPERATOR_ID,
      status: "certified",
      frontier: "closed",
      reason: "exchange_dominated",
      selected_candidate_keys: ["cand-1"],
      improvement_upper_bound: 0,
      generation_id: DIGEST_B,
      condition_digest: DIGEST_A,
      candidate_membership_changed: false,
      recorded_at: RECORDED_AT
    });
    expect(certified.frontier).toBe("closed");
    expect(() => FieldStopCertificateReceiptSchema.parse({
      ...certified,
      status: "certified",
      frontier: "incomplete",
      reason: "activation_budget_exhausted"
    })).toThrow(/inconsistent|incomplete/u);
  });

  it("keeps proof-carrying effect decisions in the closed action set", () => {
    const request = EffectRequestSchema.parse({
      action: "seal",
      target: "claim-1",
      scope: "workspace-1",
      effective_as_of: RECORDED_AT,
      supporting_receipt_ids: ["receipt-2", "receipt-1"]
    });
    const decision = EffectDecisionReceiptSchema.parse({
      schema_version: 1,
      producer: "proof_effect_v1",
      consumer: "governance",
      identity: hashEffectRequestDigest(request, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "policy_decision",
      deletion_behavior: "retain_identity",
      request_digest: hashEffectRequestDigest(request, sha256),
      action: request.action,
      target: request.target,
      scope: request.scope,
      effective_as_of: request.effective_as_of,
      decision: "require_confirmation",
      supporting_receipt_ids: request.supporting_receipt_ids,
      recorded_at: RECORDED_AT
    });
    expect(decision.decision).toBe("require_confirmation");
    expect(() => EffectDecisionReceiptSchema.parse({
      ...decision,
      decision: "maybe"
    })).toThrow();
  });

  it("names input, output, and failure disposition on every frozen port", () => {
    const failure = "fail_closed" as const;
    const source: SourceAdmissionPort = {
      input_receipt: {
        workspace_id: "workspace-1",
        source_id: "src-1",
        source_version: "v1",
        content_bytes: "bytes",
        evidence_object_id: null,
        recorded_at: RECORDED_AT,
        event_time: null,
        valid_from: null,
        valid_to: null,
        spans: [{ start_offset: 0, end_offset: 5, purpose: "sentence" }]
      },
      output_receipt: {
        record: sourceRecord(),
        spans: [AddressableSourceSpanSchema.parse(spanFields())]
      },
      failure_disposition: failure
    };
    const ports: readonly [
      FactorIncidencePort,
      ProjectionGenerationPort,
      QueryConditionPort,
      AttributedActivationPort,
      StopCertificatePort,
      ProofEffectPort,
      CausalUsagePort,
      SelectGammaPort,
      EraseBarrierPort
    ] = [
      { input_receipt: { span_id: DIGEST_A, family: "f0", canonical_payload: "x" },
        output_receipt: { incidence_id: DIGEST_B, job_id: null },
        failure_disposition: failure },
      { input_receipt: { workspace_id: "workspace-1", input_event_frontier: "e1",
        governance_frontier: "g1" },
        output_receipt: { generation_id: DIGEST_A, status: "shadow" },
        failure_disposition: failure },
      { input_receipt: { principal: "agent", effective_as_of: RECORDED_AT },
        output_receipt: { condition_digest: DIGEST_A },
        failure_disposition: failure },
      { input_receipt: { generation_id: DIGEST_A, condition_digest: DIGEST_B },
        output_receipt: { activation_receipt_id: DIGEST_A },
        failure_disposition: failure },
      { input_receipt: { generation_id: DIGEST_A, condition_digest: DIGEST_B },
        output_receipt: { status: "uncertified", frontier: "incomplete" },
        failure_disposition: "explicit_incomplete" },
      { input_receipt: { action: "erase", target: DIGEST_A, scope: "workspace-1",
        effective_as_of: RECORDED_AT, supporting_receipt_ids: [] },
        output_receipt: { decision: "deny" },
        failure_disposition: failure },
      { input_receipt: { causal_key: "use-1", downstream_ref: "path-1", weight: 1 },
        output_receipt: { receipt_id: "usage-1" },
        failure_disposition: failure },
      { input_receipt: { generation_id: DIGEST_A, condition_digest: DIGEST_B },
        output_receipt: { selected_candidate_keys: ["cand-1"] },
        failure_disposition: failure },
      { input_receipt: { subject_kind: "source_record", subject_id: DIGEST_A },
        output_receipt: { barrier_id: "barrier-1" },
        failure_disposition: failure }
    ];

    expect(source.failure_disposition).toBe("fail_closed");
    expect(ports.map((port) => port.failure_disposition)).toContain("explicit_incomplete");
  });
});

function sourceRecord() {
  const contentDigest = hashContentDigest("bytes", sha256);
  return SourceRecordIdentitySchema.parse({
    schema_version: 1,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: "projection_generation",
    identity: hashSourceRecordId({
      source_id: "src-1",
      source_version: "v1",
      content_digest: contentDigest
    }, sha256),
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "retain_identity",
    workspace_id: "workspace-1",
    source_id: "src-1",
    source_version: "v1",
    content_digest: contentDigest,
    evidence_object_id: null,
    recorded_at: RECORDED_AT,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  });
}

function spanFields() {
  return {
    schema_version: 1 as const,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: "factor_incidence",
    identity: DIGEST_A,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    record_id: DIGEST_B,
    start_offset: 0,
    end_offset: 5,
    purpose: "sentence" as const,
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: RECORDED_AT
  };
}

function usageFields() {
  return {
    schema_version: 1 as const,
    producer: "causal_usage_v1",
    consumer: "path_projection",
    identity: DIGEST_A,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    causal_key: "use-1",
    occurred_at: RECORDED_AT,
    downstream_ref: "path-1",
    weight: 0,
    scope: "workspace-1",
    usage_kind: "causal" as const,
    recorded_at: RECORDED_AT
  };
}
