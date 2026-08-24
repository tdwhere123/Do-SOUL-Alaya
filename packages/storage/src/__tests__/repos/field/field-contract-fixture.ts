import { createHash } from "node:crypto";
import {
  CAUSAL_USAGE_OPERATOR_ID,
  FACTOR_INCIDENCE_OPERATOR_ID,
  FIELD_CONTRACT_SCHEMA_VERSION,
  FIELD_OPERATOR_MANIFEST,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  fieldOperatorManifestDigest,
  hashAddressableSourceSpanId,
  hashCausalUsageId,
  hashContentDigest,
  hashDerivationJobId,
  hashEffectGovernanceFrontier,
  hashEffectRequestDigest,
  hashFactorId,
  hashGenerationId,
  hashIncidenceId,
  hashSourceRecordId,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";

export const CLOCK = "2026-08-16T00:00:00.000Z";

export const fieldSha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

export function seedWorkspaces(
  database: StorageDatabase,
  workspaceIds: readonly string[] = ["workspace-1", "workspace-2"]
): void {
  const insert = database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const workspaceId of workspaceIds) {
    insert.run(
      workspaceId,
      `Field ${workspaceId}`,
      `/tmp/${workspaceId}`,
      "local_repo",
      null,
      "active",
      CLOCK,
      null,
      null
    );
  }
}

export function openFieldDatabase(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  seedWorkspaces(database);
  return database;
}

export function hashedRecord(
  workspaceId: string,
  body: string,
  sourceId = "src-1"
) {
  const content_digest = hashContentDigest(body, fieldSha256);
  return {
    record_id: hashSourceRecordId({
      source_id: sourceId,
      source_version: "v1",
      content_digest
    }, fieldSha256),
    workspace_id: workspaceId,
    source_id: sourceId,
    source_version: "v1",
    content_digest,
    evidence_object_id: null as string | null,
    recorded_at: CLOCK,
    event_time: null as string | null,
    valid_from: null as string | null,
    valid_to: null as string | null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    source_body: body as string | null
  };
}

export function hashedSpan(
  workspaceId: string,
  recordId: string,
  start = 0,
  end = 4
) {
  return {
    span_id: hashAddressableSourceSpanId({
      record_id: recordId,
      start_offset: start,
      end_offset: end,
      purpose: "sentence",
      producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
    }, fieldSha256),
    record_id: recordId,
    start_offset: start,
    end_offset: end,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    workspace_id: workspaceId,
    recorded_at: CLOCK
  };
}

export function hashedFactor(workspaceId: string, payload: string) {
  return {
    factor_id: hashFactorId({
      family: "f0" as const,
      canonical_payload: payload,
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, fieldSha256),
    workspace_id: workspaceId,
    family: "f0" as const,
    canonical_payload: payload as string | null,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  };
}

export function hashedIncidence(
  workspaceId: string,
  spanId: string,
  factorId: string,
  scope: string
) {
  return {
    incidence_id: hashIncidenceId({
      span_id: spanId,
      factor_id: factorId,
      scope,
      operator_id: FACTOR_INCIDENCE_OPERATOR_ID
    }, fieldSha256),
    workspace_id: workspaceId,
    span_id: spanId,
    factor_id: factorId,
    scope,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  };
}

export function hashedGeneration(
  workspaceId: string,
  frontier: string,
  status: "shadow" | "verified" | "active" | "retired"
) {
  const operators = FIELD_OPERATOR_MANIFEST;
  const operator_manifest_digest = fieldOperatorManifestDigest(fieldSha256);
  const generation_id = hashGenerationId({
    operators,
    operator_manifest_digest,
    field_schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: frontier,
    governance_frontier: "gov-1"
  }, fieldSha256);
  return {
    generation_id,
    workspace_id: workspaceId,
    operator_manifest_digest,
    operator_versions_json: JSON.stringify(operators.map((entry) => [entry.id, entry.version])),
    schema_version: FIELD_CONTRACT_SCHEMA_VERSION,
    input_event_frontier: frontier,
    governance_frontier: "gov-1",
    status,
    recorded_at: CLOCK
  };
}

export function hashedJob(
  workspaceId: string,
  evidenceIds: readonly string[],
  status: "nominated" | "running" | "succeeded" | "failed" | "abandoned" = "nominated"
) {
  const purpose = "f3_semantic";
  const operator_id = "open_semantic_factor_formation_v1";
  return {
    job_id: hashDerivationJobId({
      purpose,
      operator_id,
      input_evidence_ids: evidenceIds
    }, fieldSha256),
    workspace_id: workspaceId,
    purpose,
    operator_id,
    input_evidence_ids_json: JSON.stringify(evidenceIds),
    status,
    disposition: "pending",
    recorded_at: CLOCK
  };
}

export function hashedUsage(
  workspaceId: string,
  causalKey: string,
  downstreamRef = "path-1"
) {
  const downstream_ref = downstreamRef;
  const scope = workspaceId;
  const operator_id = CAUSAL_USAGE_OPERATOR_ID;
  return {
    identity: hashCausalUsageId({
      causal_key: causalKey,
      downstream_ref,
      scope,
      operator_id
    }, fieldSha256),
    workspace_id: workspaceId,
    causal_key: causalKey,
    occurred_at: CLOCK,
    downstream_ref,
    weight: 1,
    scope,
    usage_kind: "causal" as const,
    operator_id,
    recorded_at: CLOCK
  };
}

export function hashedEffect(workspaceId: string, record: ReturnType<typeof hashedRecord>) {
  const supporting_proof_witnesses = [
    { receipt_id: "actor-proof-1", kind: "actor_authority",
      authority_event_id: "delivery-event-1", source_record_id: null,
      source_content_digest: null },
    { receipt_id: "source-proof-1", kind: "source_grounding", authority_event_id: null,
      source_record_id: record.record_id, source_content_digest: record.content_digest }
  ];
  const request = {
    schema_version: 2 as const,
    workspace_id: workspaceId,
    actor_id: "actor-1",
    run_id: "run-1",
    delivery_id: "delivery-1",
    action: "activate",
    target: "claim-1",
    scope: workspaceId,
    effective_as_of: CLOCK,
    supporting_receipt_ids: supporting_proof_witnesses.map((item) => item.receipt_id),
    supporting_proof_witnesses,
    governance_frontier: hashEffectGovernanceFrontier(
      supporting_proof_witnesses,
      fieldSha256
    ),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  };
  return {
    schema_version: request.schema_version,
    request_digest: hashEffectRequestDigest(request, fieldSha256),
    workspace_id: request.workspace_id,
    actor_id: request.actor_id,
    run_id: request.run_id,
    delivery_id: request.delivery_id,
    action: request.action,
    target: request.target,
    scope: request.scope,
    effective_as_of: request.effective_as_of,
    decision: "allow" as const,
    supporting_receipt_ids_json: JSON.stringify(request.supporting_receipt_ids),
    supporting_proof_witnesses_json: JSON.stringify(supporting_proof_witnesses),
    governance_frontier: request.governance_frontier,
    policy_operator_id: request.policy_operator_id,
    policy_operator_version: request.policy_operator_version,
    recorded_at: CLOCK
  };
}
