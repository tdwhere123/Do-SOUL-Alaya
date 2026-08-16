import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID
} from "../../../soul/associative-fact-frame.js";
import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID
} from "../../../soul/open-semantic-factor-graph.js";
import {
  ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID,
  CAUSAL_USAGE_OPERATOR_ID,
  FACTOR_INCIDENCE_OPERATOR_ID,
  FIELD_CONTRACT_SCHEMA_VERSION,
  FIELD_OPERATOR_MANIFEST,
  QUERY_CONDITION_OPERATOR_ID,
  RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  fieldOperatorManifestDigest,
  hashAddressableSourceSpanId,
  hashBundleId,
  hashCausalUsageId,
  hashConditionDigest,
  hashContentDigest,
  hashDerivationJobId,
  hashFactorId,
  hashGenerationId,
  hashIncidenceId,
  hashOperatorManifestDigest,
  hashQueryCacheKey,
  hashSourceRecordId,
  verifyFactorDescriptor,
  verifySourceRecordIdentity
} from "../../../soul/field-contract/index.js";

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

describe("field-contract identities", () => {
  it("replays the same labeled preimage regardless of object key order", () => {
    const contentDigest = hashContentDigest("source bytes", sha256);
    const first = hashSourceRecordId({
      source_id: "src-1",
      source_version: "v1",
      content_digest: contentDigest
    }, sha256);
    const second = hashSourceRecordId({
      content_digest: contentDigest,
      source_version: "v1",
      source_id: "src-1"
    }, sha256);

    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).toBe(second);
    expect(first).toBe(
      `sha256:${sha256(JSON.stringify([
        "source_record",
        "src-1",
        "v1",
        contentDigest
      ]))}`
    );
  });

  it("assigns distinct span ids to overlaps and replays the same tuple", () => {
    const recordId = hashSourceRecordId({
      source_id: "src-1",
      source_version: "v1",
      content_digest: hashContentDigest("abcdef", sha256)
    }, sha256);
    const left = hashAddressableSourceSpanId({
      record_id: recordId,
      start_offset: 0,
      end_offset: 4,
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
    }, sha256);
    const overlap = hashAddressableSourceSpanId({
      record_id: recordId,
      start_offset: 2,
      end_offset: 6,
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
    }, sha256);
    const replay = hashAddressableSourceSpanId({
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      end_offset: 4,
      start_offset: 0,
      record_id: recordId
    }, sha256);

    expect(left).not.toBe(overlap);
    expect(left).toBe(replay);
    expect(() => hashAddressableSourceSpanId({
      record_id: recordId,
      start_offset: 4,
      end_offset: 4,
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
    }, sha256)).toThrow(/half-open/u);
  });

  it("rejects operator and schema drift instead of hashing a mixed authority", () => {
    const operators = FIELD_OPERATOR_MANIFEST;
    const digest = fieldOperatorManifestDigest(sha256);
    const generation = hashGenerationId({
      operators,
      operator_manifest_digest: digest,
      field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
      input_event_frontier: "event-10",
      governance_frontier: "gov-3"
    }, sha256);
    const driftedOperators = operators.map((entry, index) =>
      index === 0 ? { ...entry, version: "2" } : entry
    );

    expect(() => hashGenerationId({
      operators: driftedOperators,
      operator_manifest_digest: digest,
      field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
      input_event_frontier: "event-10",
      governance_frontier: "gov-3"
    }, sha256)).toThrow(/manifest digest/u);
    expect(() => hashGenerationId({
      operators,
      operator_manifest_digest: digest,
      field_schema_version: "2",
      input_event_frontier: "event-10",
      governance_frontier: "gov-3"
    }, sha256)).toThrow(/schema version/u);
    expect(() => verifySourceRecordIdentity({
      schema_version: 1,
      producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
      consumer: "projection_generation",
      identity: hashSourceRecordId({
        source_id: "src-1",
        source_version: "v1",
        content_digest: hashContentDigest("bytes", sha256)
      }, sha256),
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "none",
      deletion_behavior: "retain_identity",
      workspace_id: "workspace-1",
      source_id: "src-1",
      source_version: "v1",
      content_digest: hashContentDigest("bytes", sha256),
      evidence_object_id: null,
      recorded_at: "2026-08-16T00:00:00.000Z",
      event_time: null,
      valid_from: null,
      valid_to: null,
      operator_id: "source_span_identity_v2"
    }, sha256)).toThrow(/operator id/u);
    expect(() => verifyFactorDescriptor({
      schema_version: 1,
      producer: "factor_incidence_v1",
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
      operator_id: "factor_incidence_v2",
      recorded_at: "2026-08-16T00:00:00.000Z"
    }, sha256, FACTOR_INCIDENCE_OPERATOR_ID)).toThrow(/operator id/u);
    expect(generation).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("does not let manifest version 1 substitute for operator_id", () => {
    const fromOperatorId = hashFactorId({
      family: "f0",
      canonical_payload: "token",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, sha256);
    const fromManifestVersion = hashFactorId({
      family: "f0",
      canonical_payload: "token",
      operator_id: "1"
    }, sha256);

    expect(fromOperatorId).not.toBe(fromManifestVersion);
    expect(() => verifyFactorDescriptor({
      schema_version: 1,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation",
      identity: fromManifestVersion,
      replay_rule: "idempotent_same_identity",
      failure_disposition: "fail_closed",
      governance_effect: "none",
      deletion_behavior: "rebuildable",
      workspace_id: "workspace-1",
      family: "f0",
      canonical_payload: "token",
      operator_id: "1",
      recorded_at: "2026-08-16T00:00:00.000Z"
    }, sha256)).toThrow(/operator id/u);
  });

  it("changes generation_id when the manifest or frontier changes", () => {
    const digest = fieldOperatorManifestDigest(sha256);
    const base = {
      operators: FIELD_OPERATOR_MANIFEST,
      operator_manifest_digest: digest,
      field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
      input_event_frontier: "event-10",
      governance_frontier: "gov-3"
    };
    const drifted = FIELD_OPERATOR_MANIFEST.map((entry, index) =>
      index === 0 ? { ...entry, version: "2" } : entry
    );

    expect(hashGenerationId(base, sha256)).not.toBe(hashGenerationId({
      ...base,
      input_event_frontier: "event-11"
    }, sha256));
    expect(hashGenerationId(base, sha256)).not.toBe(hashGenerationId({
      operators: drifted,
      operator_manifest_digest: hashOperatorManifestDigest(drifted, sha256),
      field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
      input_event_frontier: "event-10",
      governance_frontier: "gov-3"
    }, sha256));
  });

  it("canonicalizes derivation job evidence order before hashing", () => {
    const first = hashDerivationJobId({
      purpose: "f3_semantic",
      operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
      input_evidence_ids: ["ev-b", "ev-a"]
    }, sha256);
    const second = hashDerivationJobId({
      purpose: "f3_semantic",
      operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
      input_evidence_ids: ["ev-a", "ev-b"]
    }, sha256);

    expect(first).toBe(second);
    expect(first).toBe(
      `sha256:${sha256(JSON.stringify([
        "derivation_job",
        "f3_semantic",
        OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
        "ev-a",
        "ev-b"
      ]))}`
    );
  });

  it("preserves condition scope-stack order and isolates incidence scopes", () => {
    const canonical = {
      principal: "agent",
      authorized_scopes: ["workspace-1", "project-a"],
      explicit_bridges: ["bridge-2", "bridge-1"],
      workspace_project: "project-a",
      effective_as_of: "2026-08-16T00:00:00.000Z",
      query_task_factors: ["task-b", "task-a"],
      governance_state: "open",
      activation_budget: 8,
      token_budget: 400
    };
    const reversedScopes = {
      ...canonical,
      authorized_scopes: ["project-a", "workspace-1"]
    };
    const spanId = "sha256:" + "b".repeat(64);
    const factorId = hashFactorId({
      family: "f1",
      canonical_payload: "frame",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, sha256);

    expect(hashConditionDigest({
      ...canonical,
      request_id: "req-1",
      trace_id: "trace-9",
      span_id: "span-3"
    }, sha256)).toBe(hashConditionDigest(canonical, sha256));
    expect(hashConditionDigest(canonical, sha256))
      .not.toBe(hashConditionDigest(reversedScopes, sha256));
    expect(hashQueryCacheKey({
      generation_id: "sha256:" + "a".repeat(64),
      condition_digest: hashConditionDigest(canonical, sha256),
      query_operator_id: QUERY_CONDITION_OPERATOR_ID
    }, sha256)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashIncidenceId({
      span_id: spanId,
      factor_id: factorId,
      scope: "workspace-1",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, sha256)).not.toBe(hashIncidenceId({
      span_id: spanId,
      factor_id: factorId,
      scope: "project-a",
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, sha256));
    expect(hashBundleId({
      scope: "workspace-1",
      anchor_digest: "sha256:" + "c".repeat(64),
      level: 1,
      operator_id: "projection_generation_v1",
      generation_id: "sha256:" + "d".repeat(64)
    }, sha256)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashCausalUsageId({
      causal_key: "use-1",
      downstream_ref: "path-1",
      scope: "workspace-1",
      operator_id: CAUSAL_USAGE_OPERATOR_ID
    }, sha256)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("cites existing operator ids instead of forking them", () => {
    expect(ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID).toBe("attributed_coverage_atoms_v1");
    expect(RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID)
      .toBe("recall_field_selector_exchange_bound_v1");
    expect(FIELD_OPERATOR_MANIFEST.map((entry) => entry.id)).toEqual([
      EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
      OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
      ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID,
      "source_span_identity_v1",
      "factor_incidence_v1",
      "projection_generation_v1",
      "query_condition_v1",
      "causal_usage_v1",
      "proof_effect_v1",
      "select_gamma_v1",
      RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID
    ]);
  });
});
