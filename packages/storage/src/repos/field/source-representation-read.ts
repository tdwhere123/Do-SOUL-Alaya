import { sourceProjectionDependenciesAvailable, type SourceProjectionDependencyState,
  type SourceRecordIdentity } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "./retained-source-chunks.js";

export type SourceRecordReadAllowance = Readonly<{ workLimit?: number; nativeByteLimit?: number }>;
const DEPENDENCY_METADATA_RESERVATION = 1024;

/** SQLite supplies bounded facts; the shared source contract owns dependency eligibility. */
export function readSourceProjectionDependencies(database: StorageDatabase, source: Pick<SourceRecordIdentity,
  "workspace_id" | "scope_class" | "source_representation">, currentOrder: string,
allowance: SourceRecordReadAllowance = {}) {
  const representation = source.source_representation;
  if (representation?.kind !== "canonical_projection") {
    return { available: true, work: 0, metadataBytes: 0, resourceLimited: false, unavailable: false };
  }
  const requiredWork = 2 * representation.source_record_ids.length;
  const requiredBytes = DEPENDENCY_METADATA_RESERVATION * representation.source_record_ids.length;
  if ((allowance.workLimit ?? Infinity) < 5 + requiredWork ||
      (allowance.nativeByteLimit ?? Infinity) < RETAINED_SOURCE_READ_RESERVATION + requiredBytes) {
    return { available: false, work: 0, metadataBytes: 0, resourceLimited: true, unavailable: false };
  }
  const statement = database.connection.prepare(`SELECT
    CASE WHEN octet_length(origin.record_id) <= 71 THEN origin.record_id END AS identity,
    CASE WHEN octet_length(origin.workspace_id) <= 256 THEN origin.workspace_id END AS workspace_id,
    CASE WHEN octet_length(origin.scope_class) <= 32 THEN origin.scope_class END AS scope_class,
    CASE WHEN octet_length(json_extract(origin.source_representation_json, '$.kind')) <= 32
      THEN json_extract(origin.source_representation_json, '$.kind') END AS representation_kind,
    octet_length(origin.source_body) IS NOT NULL AS body_available,
    (SELECT CASE WHEN octet_length(record_id) <= 71 THEN record_id END FROM source_records INDEXED BY idx_source_records_current
      WHERE workspace_id = origin.workspace_id AND source_id = origin.source_id
      ORDER BY ${currentOrder} LIMIT 1) AS current_identity
    FROM source_records origin WHERE origin.workspace_id = ? AND origin.record_id = ? LIMIT 1`);
  let metadataBytes = 0, unavailable = false;
  const facts = representation.source_record_ids.map((id): SourceProjectionDependencyState => {
    const row = statement.get(source.workspace_id, id) as { identity: string | null; workspace_id: string | null;
      scope_class: SourceRecordIdentity["scope_class"]; representation_kind: "original_body" | "retained_excerpt" | "canonical_projection" | null;
      body_available: number; current_identity: string | null } | undefined;
    if (row === undefined) return null;
    metadataBytes += Buffer.byteLength(JSON.stringify(row), "utf8");
    if (row.identity === null || row.workspace_id === null || row.current_identity === null) { unavailable = true; return null; }
    return { identity: row.identity, workspace_id: row.workspace_id, scope_class: row.scope_class,
      current_identity: row.current_identity, body_available: row.body_available === 1,
      ...(row.representation_kind === null ? {} : { source_representation: { kind: row.representation_kind } }) };
  });
  return { available: !unavailable && sourceProjectionDependenciesAvailable(source, facts), work: requiredWork,
    metadataBytes, resourceLimited: false, unavailable };
}
