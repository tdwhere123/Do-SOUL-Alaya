import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AddressableSourceSpanSchema,
  CAUSAL_USAGE_OPERATOR_ID,
  CausalUsageReceiptSchema,
  EffectDecisionReceiptSchema,
  EffectRequestSchema,
  FACTOR_INCIDENCE_OPERATOR_ID,
  FIELD_CONTRACT_SCHEMA_VERSION,
  FIELD_OPERATOR_MANIFEST,
  FactorDescriptorSchema,
  FieldProjectionGenerationSchema,
  ProjectionEraseBarrierSchema,
  QUERY_CONDITION_OPERATOR_ID,
  QueryConditionReceiptSchema,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  classifyFieldValidTime,
  fieldOperatorManifestDigest,
  hashAddressableSourceSpanId,
  hashCausalUsageId,
  hashConditionDigest,
  hashContentDigest,
  hashEffectRequestDigest,
  hashEffectGovernanceFrontier,
  hashFactorId,
  hashGenerationId,
  hashOperatorManifestDigest,
  hashQueryCacheKey,
  hashSourceRecordId,
  verifyAddressableSourceSpan,
  verifyCausalUsageReceipt,
  verifyFactorDescriptor,
  verifyFieldProjectionGeneration,
  verifyQueryConditionReceipt
} from "../../../recall/field-contract/index.js";

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
    expect(classifyFieldValidTime({
      valid_from: "2026-08-16T00:00:01.000Z",
      valid_to: null
    }, RECORDED_AT)).toBe("inactive");
    expect(classifyFieldValidTime({
      valid_from: "2026-08-15T00:00:00.000Z",
      valid_to: RECORDED_AT
    }, RECORDED_AT)).toBe("inactive");
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

  it("parses an erased factor descriptor without re-hashing a null payload", () => {
    const live = verifyFactorDescriptor({
      schema_version: 1,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation",
      identity: hashFactorId({
        family: "f0",
        canonical_payload: "token",
        operator_id: FACTOR_INCIDENCE_OPERATOR_ID
      }, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "none",
      deletion_behavior: "rebuildable",
      workspace_id: "workspace-1",
      family: "f0",
      canonical_payload: "token",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
      recorded_at: RECORDED_AT
    }, sha256);
    const erased = FactorDescriptorSchema.parse({
      ...live,
      canonical_payload: null,
      deletion_behavior: "content_free_tombstone"
    });

    expect(erased.identity).toBe(live.identity);
    expect(verifyFactorDescriptor(erased, sha256).canonical_payload).toBeNull();
  });

  it("binds query cache keys to generation, condition, and operator id", () => {
    const condition = {
      principal: "agent",
      workspace_id: "workspace-1",
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
      producer: QUERY_CONDITION_OPERATOR_ID,
      consumer: "attributed_activation",
      identity: hashConditionDigest(condition, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "none",
      deletion_behavior: "rebuildable",
      condition,
      generation_id: DIGEST_A,
      query_operator_id: QUERY_CONDITION_OPERATOR_ID,
      query_cache_key: hashQueryCacheKey({
        generation_id: DIGEST_A,
        condition_digest: hashConditionDigest(condition, sha256),
        query_operator_id: QUERY_CONDITION_OPERATOR_ID
      }, sha256),
      recorded_at: RECORDED_AT
    });

    expect(verifyQueryConditionReceipt(receipt, sha256).identity).toBe(
      hashConditionDigest({ ...condition, request_id: "other" }, sha256)
    );
  });

  it("verifies span, generation, and usage identities against the hasher", () => {
    const span = verifyAddressableSourceSpan(spanFields(), sha256);
    const generation = verifyFieldProjectionGeneration(generationReceipt(), sha256);
    const usage = verifyCausalUsageReceipt(usageFields(), sha256);

    expect(span.identity).toBe(hashAddressableSourceSpanId(span, sha256));
    expect(generation.identity).toBe(generation.generation_id);
    expect(usage.identity).toBe(hashCausalUsageId(usage, sha256));
  });

  it("rejects a self-certified noncanonical generation manifest", () => {
    const canonical = generationReceipt();
    const operators = canonical.operator_versions.map(([id, version], index):
      [string, string] => [id, index === 0 ? "99" : version]
    );
    const entries = operators.map(([id, version]) => ({ id, version }));
    const digest = hashOperatorManifestDigest(entries, sha256);
    const generationId = hashGenerationId({
      operators: entries,
      operator_manifest_digest: digest,
      field_schema_version: canonical.field_schema_version,
      input_event_frontier: canonical.input_event_frontier,
      governance_frontier: canonical.governance_frontier
    }, sha256);
    expect(() => verifyFieldProjectionGeneration({
      ...canonical,
      identity: generationId,
      generation_id: generationId,
      operator_manifest_digest: digest,
      operator_versions: operators
    }, sha256)).toThrow(/canonical operator manifest/u);
  });

  it("rejects a self-certified v2 Select_Gamma manifest", () => {
    const canonical = generationReceipt();
    const operators = canonical.operator_versions.map(([id, version]):
      [string, string] => (
        id.startsWith("select_gamma")
          ? [
              "select_gamma_relevance_temporal_query_coverage_authority_tiebreak_v2",
              "2"
            ]
          : [id, version]
      )
    );
    const entries = operators.map(([id, version]) => ({ id, version }));
    const digest = hashOperatorManifestDigest(entries, sha256);
    const generationId = hashGenerationId({
      operators: entries,
      operator_manifest_digest: digest,
      field_schema_version: canonical.field_schema_version,
      input_event_frontier: canonical.input_event_frontier,
      governance_frontier: canonical.governance_frontier
    }, sha256);

    expect(() => verifyFieldProjectionGeneration({
      ...canonical,
      identity: generationId,
      generation_id: generationId,
      operator_manifest_digest: digest,
      operator_versions: operators
    }, sha256)).toThrow(/canonical operator manifest/u);
  });

  it("keeps proof-carrying effect decisions in the closed action set", () => {
    const witnesses = [
      { receipt_id: "receipt-2", kind: "actor_authority",
        authority_event_id: "delivery-event-1", source_record_id: null,
        source_content_digest: null },
      { receipt_id: "receipt-1", kind: "source_grounding", authority_event_id: null,
        source_record_id: "source-1",
        source_content_digest: DIGEST_A }
    ];
    const request = EffectRequestSchema.parse({
      schema_version: 2,
      workspace_id: "workspace-1",
      actor_id: "actor-1",
      run_id: "run-1",
      delivery_id: "delivery-1",
      action: "seal",
      target: "claim-1",
      scope: "workspace-1",
      effective_as_of: RECORDED_AT,
      supporting_receipt_ids: ["receipt-2", "receipt-1"],
      supporting_proof_witnesses: witnesses,
      governance_frontier: hashEffectGovernanceFrontier(witnesses, sha256),
      policy_operator_id: "proof_effect_v1",
      policy_operator_version: "1"
    });
    const decision = EffectDecisionReceiptSchema.parse({
      schema_version: 2,
      producer: "proof_effect_v1",
      consumer: "governance",
      identity: hashEffectRequestDigest(request, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "policy_decision",
      deletion_behavior: "retain_identity",
      workspace_id: request.workspace_id,
      actor_id: request.actor_id,
      run_id: request.run_id,
      delivery_id: request.delivery_id,
      request_digest: hashEffectRequestDigest(request, sha256),
      action: request.action,
      target: request.target,
      scope: request.scope,
      effective_as_of: request.effective_as_of,
      decision: "require_confirmation",
      supporting_receipt_ids: request.supporting_receipt_ids,
      supporting_proof_witnesses: request.supporting_proof_witnesses,
      governance_frontier: request.governance_frontier,
      policy_operator_id: request.policy_operator_id,
      policy_operator_version: request.policy_operator_version,
      recorded_at: RECORDED_AT
    });
    expect(decision.decision).toBe("require_confirmation");
    for (const field of ["workspace_id", "actor_id", "run_id", "delivery_id"] as const) {
      expect(hashEffectRequestDigest({ ...request, [field]: `other-${field}` }, sha256))
        .not.toBe(decision.request_digest);
    }
    expect(() => EffectDecisionReceiptSchema.parse({
      ...decision,
      decision: "maybe"
    })).toThrow();
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
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  });
}

function spanFields() {
  const recordId = hashSourceRecordId({
    source_id: "src-1",
    source_version: "v1",
    content_digest: hashContentDigest("bytes", sha256)
  }, sha256);
  const identity = hashAddressableSourceSpanId({
    record_id: recordId,
    start_offset: 0,
    end_offset: 5,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, sha256);
  return {
    schema_version: 1 as const,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: "factor_incidence",
    identity,
    replay_rule: "idempotent_same_identity" as const,
    failure_disposition: "fail_closed" as const,
    governance_effect: "none" as const,
    deletion_behavior: "retain_identity" as const,
    workspace_id: "workspace-1",
    record_id: recordId,
    start_offset: 0,
    end_offset: 5,
    purpose: "sentence" as const,
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: RECORDED_AT
  };
}

function usageFields() {
  const identity = hashCausalUsageId({
    causal_key: "use-1",
    downstream_ref: "path-1",
    scope: "workspace-1",
    operator_id: CAUSAL_USAGE_OPERATOR_ID
  }, sha256);
  return {
    schema_version: 1 as const,
    producer: CAUSAL_USAGE_OPERATOR_ID,
    consumer: "path_projection",
    identity,
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
    operator_id: CAUSAL_USAGE_OPERATOR_ID,
    recorded_at: RECORDED_AT
  };
}

function generationReceipt() {
  const operators = FIELD_OPERATOR_MANIFEST;
  const digest = fieldOperatorManifestDigest(sha256);
  const generationId = hashGenerationId({
    operators,
    operator_manifest_digest: digest,
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: "event-1",
    governance_frontier: "gov-1"
  }, sha256);
  return FieldProjectionGenerationSchema.parse({
    schema_version: 1,
    producer: "projection_generation_v1",
    consumer: "activation",
    identity: generationId,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    workspace_id: "workspace-1",
    generation_id: generationId,
    operator_manifest_digest: digest,
    operator_versions: operators.map((entry) => [entry.id, entry.version] as const),
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: "event-1",
    governance_frontier: "gov-1",
    status: "shadow",
    recorded_at: RECORDED_AT
  });
}
