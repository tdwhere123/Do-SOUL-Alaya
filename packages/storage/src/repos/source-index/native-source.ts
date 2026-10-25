import {
  SOURCE_INDEX_MAX_BODY_BYTES, SOURCE_INDEX_MAX_PAGE_ROWS, SourceIndexOperationError, sourceIndexTarget,
  type SourceIndexBudget, type SourceIndexReadResult, type SourceIndexResources, type SourceIndexTarget,
  type SourceIndexMessageStructure
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { SqliteFieldSourceRecordRepo, type BoundedSourceRecordRead } from "../field/source-repo.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";

import { guardCapsuleIndexTarget, readCapsuleIndexChunk } from "./capsule-source.js";

const SOURCE_READ_WORK = 5;
export const SOURCE_INDEX_STANDALONE_BUDGET: SourceIndexBudget = { work: 1000, native_bytes: 131072 };

export function assertIndexBudget(budget: SourceIndexBudget): void {
  for (const value of [budget.work, budget.native_bytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("VALIDATION_FAILED", "invalid source index budget");
  }
}
export function assertIndexPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_INDEX_MAX_PAGE_ROWS) {
    throw new StorageError("VALIDATION_FAILED", "invalid source index page limit");
  }
}
export function sourceReadCost(read: BoundedSourceRecordRead): SourceIndexResources {
  return { work: SOURCE_READ_WORK + read.dependencyWork, native_bytes: read.nativeBytes + read.metadataBytes };
}
export function sourceTargetFromRead(read: BoundedSourceRecordRead): SourceIndexTarget | null {
  const row = read.record;
  if (row === null || row.source_body === null) return null;
  return sourceIndexTarget({ kind: "source_evidence", workspace_id: row.workspace_id,
    root_kind: "source_record", root_id: row.record_id, source_version: row.source_version,
    content_digest: row.content_digest, evidence_object_id: row.evidence_object_id }, row.source_id, read.bodyBytes);
}

/** The native dependency-aware reader, not a parallel eligibility rule, owns availability. */
export function guardSourceIndexTarget(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, budget: SourceIndexBudget = SOURCE_INDEX_STANDALONE_BUDGET) {
  assertIndexBudget(budget);
  const resources = { work: 0, native_bytes: 0 };
  try {
    // Reserve only the native reader's fixed envelope; it owns dependency-specific admission.
    if (budget.work < SOURCE_READ_WORK || budget.native_bytes < RETAINED_SOURCE_READ_RESERVATION) {
      return { status: "partial" as const, reason: "read_budget" as const, resources };
    }
    if (source.target.root_kind === "evidence_capsule") return guardCapsuleIndexTarget(database, source, budget);
    if (source.source_id === null) return { status: "stale" as const, reason: "source_identity", resources };
    const read = records.findCurrentBounded(source.target.workspace_id, source.source_id, 4, 0,
      { workLimit: budget.work, nativeByteLimit: budget.native_bytes });
    Object.assign(resources, read === null ? { work: 1, native_bytes: 0 } : sourceReadCost(read));
    if (read === null) return { status: "stale" as const, reason: "missing_source", resources };
    if (read.resourceLimited) return { status: "partial" as const, reason: "read_budget" as const, resources };
    if (read.record === null) return { status: "partial" as const, reason: "native_source_unavailable" as const, resources };
    const current = sourceTargetFromRead(read);
    if (current === null) return { status: read.bodyBytes > 0 ? "partial" as const : "stale" as const,
      reason: "native_source_unavailable" as const, resources };
    if (current.root_key !== source.root_key || current.body_bytes !== source.body_bytes) {
      return { status: "stale" as const, reason: "source_changed", resources };
    }
    const dependencies = read.record.source_representation;
    const ids = [source.target.root_id, ...(dependencies?.kind === "canonical_projection" ? dependencies.source_record_ids : [])];
    // Erase admission can precede body scrubbing in the same native transaction.
    for (const id of ids) {
      if (resources.work >= budget.work) return { status: "partial" as const, reason: "read_budget" as const, resources };
      resources.work++;
      if (database.connection.prepare(`SELECT 1 FROM projection_erase_barriers
        WHERE workspace_id = ? AND subject_kind = 'source_record' AND subject_id = ? LIMIT 1`)
        .get(source.target.workspace_id, id) !== undefined) return { status: "stale" as const, reason: "source_erased", resources };
    }
    return { status: "ready" as const, resources, scope_class: read.record.scope_class ?? null,
      dependencies: dependencies?.kind === "canonical_projection" ? dependencies.source_record_ids : [] };
  } catch (error) {
    throw new SourceIndexOperationError(error, resources);
  }
}

/** Uses the existing source-owned bounded inventory reader, with all work and bytes charged.
 * Unavailable/invalid/incomplete reads refuse preparation; only genuine unknown uses the fallback.
 */
export function readSourceIndexMessageStructure(records: SqliteFieldSourceRecordRepo, source: SourceIndexTarget,
  budget: SourceIndexBudget): { status: "ready"; structure: SourceIndexMessageStructure; resources: SourceIndexResources } |
    { status: "partial"; reason: string; resources: SourceIndexResources } {
  assertIndexBudget(budget);
  if (source.target.root_kind === "evidence_capsule") return { status: "ready", structure: { status: "not_applicable" },
    resources: { work: 0, native_bytes: 0 } };
  const read = records.readHostInventory({ workspaceId: source.target.workspace_id, recordId: source.target.root_id,
    sourceVersion: source.target.source_version, contentDigest: source.target.content_digest, authorizedScopes: null,
    workLimit: budget.work, nativeByteLimit: budget.native_bytes,
    memoryLimit: Math.min(3 * budget.native_bytes, 3 * (SOURCE_INDEX_MAX_BODY_BYTES + 8192)) });
  const resources = { work: read.work, native_bytes: read.nativeBytes };
  if (read.status === "unknown") return { status: "ready", structure: { status: "unknown" }, resources };
  if (read.status !== "captured" || read.inventory === undefined) return { status: "partial",
    reason: read.status === "resource_limited" ? "read_budget" : `message_structure_${read.status}`, resources };
  return { status: "ready", structure: { status: "captured", occurrences: read.inventory.occurrences.map(row => ({
    utf8_span: row.utf8_span, completeness: row.completeness
  })) }, resources };
}

/** Bounded complete-body assembly for Core's projection computation, never a successful prefix. */
export function readSourceIndexDocument(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, maxBytes: number, budget: SourceIndexBudget): SourceIndexReadResult {
  assertIndexBudget(budget);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > SOURCE_INDEX_MAX_BODY_BYTES) {
    throw new StorageError("VALIDATION_FAILED", "invalid source index body limit");
  }
  const resources = { work: 0, native_bytes: 0 };
  try {
    const guard = guardSourceIndexTarget(database, records, source, budget);
    Object.assign(resources, guard.resources);
    if (guard.status !== "ready") return { status: guard.status, reason: guard.reason, resources };
    if (source.body_bytes > maxBytes) return { status: "partial", reason: "body_capacity", resources };
    const parts: string[] = [];
    let offset = 0;
    while (offset < source.body_bytes) {
      if (budget.work - resources.work < SOURCE_READ_WORK ||
          budget.native_bytes - resources.native_bytes < RETAINED_SOURCE_READ_RESERVATION) {
        return { status: "partial", reason: "read_budget", resources };
      }
      if (source.target.root_kind === "evidence_capsule") {
        const read = readCapsuleIndexChunk(database, source, Math.min(65536, source.body_bytes - offset), offset);
        resources.work += read.resources.work; resources.native_bytes += read.resources.native_bytes;
        if (read.row?.content === undefined || read.row.content_end <= offset) {
          return { status: "partial", reason: "incomplete_source_bytes", resources };
        }
        parts.push(read.row.content); offset = read.row.content_end;
        continue;
      }
      const read = records.findByIdBounded(source.target.workspace_id, source.target.root_id,
        Math.min(65536, source.body_bytes - offset), offset,
        { workLimit: budget.work - resources.work, nativeByteLimit: budget.native_bytes - resources.native_bytes });
      if (read === null) { resources.work++; return { status: "stale", reason: "missing_source", resources }; }
      const cost = sourceReadCost(read);
      resources.work += cost.work; resources.native_bytes += cost.native_bytes;
      if (read.resourceLimited) return { status: "partial", reason: "read_budget", resources };
      if (read.invalidOffset) return { status: "partial", reason: "incomplete_source_bytes", resources };
      if (read.record?.source_body == null) return { status: "partial", reason: "native_source_unavailable", resources };
      if (read.prefixBytes === 0) return { status: "partial", reason: "incomplete_source_bytes", resources };
      parts.push(read.record.source_body); offset += read.prefixBytes;
    }
    return { status: "ready", source, body: parts.join(""), resources };
  } catch (error) {
    throw new SourceIndexOperationError(error, resources);
  }
}
