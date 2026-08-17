import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashFactorId,
  hashIncidenceId,
  hashSourceRecordId
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";

export function seedSourceBoundRecall(input: Readonly<{
  database: StorageDatabase;
  workspaceId: string;
  runId: string | null;
  evidenceId: string;
  factorValue: string;
  body: string;
  recordedAt: string;
}>): void {
  ensureEvidenceCapsule(input);
  const stores = createDaemonFieldComposition({
    database: input.database,
    eventLogRepo: new SqliteEventLogRepo(input.database),
    sha256: fieldContractSha256
  }).stores;
  const contentDigest = hashContentDigest(input.body, fieldContractSha256);
  const recordId = hashSourceRecordId({
    source_id: `test-source:${input.evidenceId}`,
    source_version: "1",
    content_digest: contentDigest
  }, fieldContractSha256);
  stores.putRecord({
    ...receiptFields(recordId, SOURCE_SPAN_IDENTITY_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: input.workspaceId,
    source_id: `test-source:${input.evidenceId}`,
    source_version: "1",
    content_digest: contentDigest,
    evidence_object_id: input.evidenceId,
    recorded_at: input.recordedAt,
    event_time: input.recordedAt,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, input.body);
  const spanId = putSpan(stores, input, recordId);
  putFactorIncidence(stores, input, spanId);
}

function ensureEvidenceCapsule(input: Parameters<typeof seedSourceBoundRecall>[0]): void {
  input.database.connection.prepare(`
    INSERT OR IGNORE INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'system', 'user_statement',
      ?, NULL, NULL, 'verified', ?, NULL, NULL, ?, ?, NULL)
  `).run(
    input.evidenceId,
    input.recordedAt,
    input.recordedAt,
    JSON.stringify({
      topic: input.factorValue,
      keywords: [input.factorValue],
      summary: input.body
    }),
    input.body,
    input.runId,
    input.workspaceId
  );
}

function putSpan(
  stores: ReturnType<typeof createDaemonFieldComposition>["stores"],
  input: Parameters<typeof seedSourceBoundRecall>[0],
  recordId: string
): string {
  const spanId = hashAddressableSourceSpanId({
    record_id: recordId,
    start_offset: 0,
    end_offset: input.body.length,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, fieldContractSha256);
  stores.putSpan({
    ...receiptFields(spanId, SOURCE_SPAN_IDENTITY_OPERATOR_ID, "factor_incidence"),
    schema_version: 1,
    workspace_id: input.workspaceId,
    record_id: recordId,
    start_offset: 0,
    end_offset: input.body.length,
    purpose: "sentence",
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: input.recordedAt
  });
  return spanId;
}

function putFactorIncidence(
  stores: ReturnType<typeof createDaemonFieldComposition>["stores"],
  input: Parameters<typeof seedSourceBoundRecall>[0],
  spanId: string
): void {
  const factorId = hashFactorId({
    family: "f1",
    canonical_payload: input.factorValue,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldContractSha256);
  stores.putDescriptor({
    ...receiptFields(factorId, FACTOR_INCIDENCE_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: input.workspaceId,
    family: "f1",
    canonical_payload: input.factorValue,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: input.recordedAt
  });
  const incidenceId = hashIncidenceId({
    span_id: spanId,
    factor_id: factorId,
    scope: input.workspaceId,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldContractSha256);
  stores.putIncidence({
    ...receiptFields(incidenceId, FACTOR_INCIDENCE_OPERATOR_ID, "projection_generation"),
    schema_version: 1,
    workspace_id: input.workspaceId,
    span_id: spanId,
    factor_id: factorId,
    scope: input.workspaceId,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: input.recordedAt
  });
}

function receiptFields(identity: string, producer: string, consumer: string) {
  return fieldReceiptContractFields({ identity, producer, consumer });
}
