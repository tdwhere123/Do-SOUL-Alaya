import {
  SourceSemanticResourceExhausted, hostOccurrenceIsMessage, sourceIndexTarget,
  type SourceIndexHostDependencyRead, type SourceIndexHostDependencyReference,
  type SourceIndexScopeAdmission, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";
import { QueryReadMeter } from "./query-read-meter.js";
import { sourceReadCost } from "./native-source.js";

/** Source-owned inventory validation supplies currentness and literal occurrence identity.
 * Unlike extraction-context dependencies, an unavailable contextual prerequisite never
 * makes its referring source unavailable. No message bytes are read before authorization.
 */
export function readHostDependency(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  workspaceId: string, reference: SourceIndexHostDependencyReference, occurrenceId: string | null,
  budget: SourceSemanticResourceBudget, admit: SourceIndexScopeAdmission,
  window?: Readonly<{ start_offset?: number; byte_limit: number; metadata_only?: boolean }>): SourceIndexHostDependencyRead {
  const meter = new QueryReadMeter(budget);
  const failure = (status: "unknown" | "unavailable" | "denied" | "invalid" | "resource_limited", reason: string): SourceIndexHostDependencyRead =>
    ({ status, reason, resources: meter.resources() });
  try {
    meter.ledger.reserve(8193, 24_576, "host dependency identity header");
    meter.read(1, 0);
    const row = database.connection.prepare(`SELECT
      CASE WHEN octet_length(source_id)<=1024 THEN source_id END AS source_id,
      CASE WHEN octet_length(scope_class)<=32 THEN scope_class END AS scope_class,
      CASE WHEN octet_length(evidence_object_id)<=1024 THEN evidence_object_id END AS evidence_object_id,
      source_version = ? AND content_digest = ? AS bound,
      octet_length(source_body) AS body_bytes,
      EXISTS (SELECT 1 FROM projection_erase_barriers b WHERE b.workspace_id=s.workspace_id
        AND b.subject_kind='source_record' AND b.subject_id=s.record_id) AS erased
      FROM source_records s WHERE workspace_id=? AND record_id=?`)
      .get(reference.source_version, reference.content_digest, workspaceId, reference.root_id) as {
        source_id: string | null; scope_class: string | null; evidence_object_id: string | null;
        bound: number; body_bytes: number | null; erased: number
      } | undefined;
    if (row === undefined) return failure("unavailable", "missing_source");
    const bytes = Buffer.byteLength(JSON.stringify(row));
    meter.read(0, bytes); meter.ledger.charge(bytes, bytes * 2, "host dependency header decode");
    if (row.bound !== 1 || row.erased !== 0 || row.body_bytes === null || row.source_id === null
      || reference.source_id !== undefined && reference.source_id !== row.source_id) return failure("unavailable", "source_binding");
    const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: workspaceId, root_kind: "source_record",
      root_id: reference.root_id, source_version: reference.source_version, content_digest: reference.content_digest,
      evidence_object_id: row.evidence_object_id }, row.source_id, row.body_bytes);
    meter.ledger.retain(source, "host dependency target");
    if (admit(row.scope_class, source) !== "admitted") return failure("denied", "source_scope");
    const read = records.readHostInventory({ workspaceId, recordId: reference.root_id,
      sourceVersion: reference.source_version, contentDigest: reference.content_digest, authorizedScopes: null,
      workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes, memoryLimit: meter.ledger.bytes });
    meter.absorbQuery({ work: read.work, native_bytes: read.nativeBytes, memory_bytes: read.memory, sql_internal_work: "unknown" });
    if (read.status !== "captured") return failure(read.status, `host_inventory_${read.status}`);
    if (read.inventory === undefined) return failure("invalid", "host_inventory_missing");
    const inventory = read.inventory;
    if (occurrenceId === null) return { status: "ready", source, inventory, resources: meter.resources() };
    meter.ledger.charge(inventory.occurrences.length, 0, "host dependency occurrence binding");
    const occurrence = inventory.occurrences.find(item => item.occurrence_id === occurrenceId);
    if (occurrence === undefined || !hostOccurrenceIsMessage(occurrence)) return failure("unavailable", "missing_complete_occurrence");
    const [start, end] = occurrence.utf8_span;
    if (end > source.body_bytes) return failure("invalid", "occurrence_extent");
    if (window?.metadata_only) return { status: "ready", source, inventory, occurrence, resources: meter.resources() };
    const from = window?.start_offset === undefined || window.start_offset === 0 ? start : window.start_offset;
    const limit = window?.byte_limit ?? end - start;
    if (!Number.isSafeInteger(from) || from < start || from >= end || !Number.isSafeInteger(limit) || limit < 0) {
      return failure("invalid", "dependency_window");
    }
    const through = Math.min(end, from + limit);
    const parts: string[] = [];
    let offset = from;
    while (offset < through) {
      const count = Math.min(4096, through - offset);
      meter.ledger.reserve(count + 5, 2 * count + RETAINED_SOURCE_READ_RESERVATION, "host dependency message bytes");
      meter.ledger.charge(count, count * 2, "host dependency message decode");
      const part = records.findByIdBounded(workspaceId, reference.root_id, count, offset,
        { workLimit: meter.ledger.work, nativeByteLimit: meter.ledger.bytes });
      if (part === null) { meter.read(1, 0); return failure("unavailable", "missing_source"); }
      meter.absorb(sourceReadCost(part));
      if (part.resourceLimited) return failure("resource_limited", "message_read_budget");
      if (part.invalidOffset || part.record?.source_body == null || part.prefixBytes < 1
        || offset + part.prefixBytes > through) {
        if (!part.invalidOffset && part.prefixBytes === 0 && through < end) break;
        return failure("unavailable", "message_bytes_unavailable");
      }
      parts.push(part.record.source_body); offset += part.prefixBytes;
    }
    meter.ledger.charge(offset - from, (offset - from) * 2, "host dependency message assembly");
    return { status: "ready", source, inventory, occurrence, text: parts.join(""), content_span: [from, offset],
      content_complete: from === start && offset === end, resources: meter.resources() };
  } catch (error) {
    return failure(error instanceof SourceSemanticResourceExhausted ? "resource_limited" : "invalid",
      error instanceof SourceSemanticResourceExhausted ? `read_budget:${error.phase}` : "host_dependency_read_failed");
  }
}
