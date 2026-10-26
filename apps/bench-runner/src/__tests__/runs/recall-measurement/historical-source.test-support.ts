import { canonicalJson, hashSourceRecordId } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import type { FieldSourceRecordRow, StorageDatabase } from "@do-soul/alaya-storage";
import { writeRetainedSourceChunks } from "../../../../../../packages/storage/src/repos/field/retained-source-chunks.js";

/** Author schema 20–23 fixtures directly; the current source writer intentionally refuses pre-host schemas. */
export function insertPreHostSourceRecord(database: StorageDatabase, input: FieldSourceRecordRow): FieldSourceRecordRow {
  const record = { ...input, record_id: hashSourceRecordId(input, fieldContractSha256) };
  database.connection.prepare(`INSERT INTO source_records (workspace_id, record_id, source_id, source_version,
    content_digest, evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker,
    scope_class, attribution_context_json, source_representation_json, source_body, retained_content_bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(record.workspace_id, record.record_id, record.source_id, record.source_version, record.content_digest,
      record.evidence_object_id, record.recorded_at, record.event_time, record.valid_from, record.valid_to,
      record.operator_id, record.speaker, record.scope_class,
      record.attribution_context === null ? null : canonicalJson(record.attribution_context),
      record.source_representation === undefined ? null : canonicalJson(record.source_representation),
      record.source_body, record.source_body === null ? null : Buffer.byteLength(record.source_body));
  if (record.source_body !== null) {
    writeRetainedSourceChunks(database, { workspaceId: record.workspace_id, kind: "source_record",
      rootId: record.record_id, revision: record.source_version, digest: record.content_digest }, record.source_body);
  }
  return record;
}
