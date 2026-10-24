import { sourceIndexTarget, SourceIndexOperationError, type SourceIndexBudget, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { BoundedCapsuleSourceReader, type BoundedCapsuleSource } from "../capsules/reads/bounded-capsule-source-reader.js";
import { capsuleMetadataBytes, mapBoundedCapsule } from "../field/bounded-source-root-reader.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";

export function capsuleReadCost(read: BoundedCapsuleSource) {
  return { work: 5, native_bytes: read.nativeBytes + capsuleMetadataBytes(read) };
}

/** The retained reader owns excerpt/gist selection, revision, digest and UTF-8 extent. */
export function capsuleTargetFromRead(read: BoundedCapsuleSource): SourceIndexTarget | null {
  const row = mapBoundedCapsule(read, 4, 0);
  if (row === null) return null;
  try {
    return sourceIndexTarget({ kind: "source_evidence", workspace_id: row.workspace_id,
      root_kind: row.kind, root_id: row.root_id, source_version: row.revision,
      content_digest: row.digest, evidence_object_id: row.evidence_object_id }, null, read.body_bytes!);
  } catch {
    // Invalid native metadata is unknown, not a successfully absent root or an advancing cursor.
    return null;
  }
}

export function guardCapsuleIndexTarget(database: StorageDatabase, source: SourceIndexTarget, budget: SourceIndexBudget) {
  const resources = { work: 0, native_bytes: 0 };
  if (budget.work < 6 || budget.native_bytes < RETAINED_SOURCE_READ_RESERVATION) {
    return { status: "partial" as const, reason: "read_budget" as const, resources };
  }
  try {
    const read = new BoundedCapsuleSourceReader(database).readCandidate(source.target.workspace_id, source.target.root_id, 4);
    Object.assign(resources, read === null ? { work: 1, native_bytes: 0 } : capsuleReadCost(read));
    if (read === null || read.linked === 1) return { status: "stale" as const, reason: "missing_source", resources };
    const current = capsuleTargetFromRead(read);
    if (current === null) return { status: "partial" as const, reason: "native_source_unavailable" as const, resources };
    if (current.root_key !== source.root_key || current.body_bytes !== source.body_bytes || source.source_id !== null ||
        current.target.evidence_object_id !== source.target.evidence_object_id) {
      return { status: "stale" as const, reason: "source_changed", resources };
    }
    resources.work++;
    if (database.connection.prepare(`SELECT 1 FROM source_record_evidence_refs ref JOIN projection_erase_barriers barrier
      ON barrier.workspace_id=ref.workspace_id AND barrier.subject_kind='source_record' AND barrier.subject_id=ref.record_id
      WHERE ref.workspace_id=? AND ref.evidence_object_id=? LIMIT 1`)
      .get(source.target.workspace_id, source.target.root_id) !== undefined) {
      return { status: "stale" as const, reason: "source_erased", resources };
    }
    return { status: "ready" as const, resources, scope_class: null, dependencies: [] as readonly string[] };
  } catch (error) {
    throw new SourceIndexOperationError(error, resources);
  }
}

export function readCapsuleIndexChunk(database: StorageDatabase, source: SourceIndexTarget, bytes: number, offset: number) {
  const read = new BoundedCapsuleSourceReader(database).read(source.target.workspace_id, source.target.root_id, bytes, offset);
  const row = read === null ? null : mapBoundedCapsule(read, bytes, offset);
  return { row, resources: read === null ? { work: 1, native_bytes: 0 } : capsuleReadCost(read) };
}
