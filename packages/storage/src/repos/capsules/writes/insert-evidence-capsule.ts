import { createHash } from "node:crypto";
import type { EvidenceCapsule, EvidenceSearchProjection } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { writeRetainedSourceChunks } from "../../field/retained-source-chunks.js";
import type { EvidenceCapsuleStatements } from "../statements/evidence-capsule-statements.js";

export function insertEvidenceCapsule(
  db: StorageDatabase,
  statements: EvidenceCapsuleStatements,
  capsule: EvidenceCapsule,
  searchProjections: readonly Readonly<EvidenceSearchProjection>[],
  sourceProvenance: boolean
): void {
  const retained = capsule.excerpt ?? capsule.gist;
  const digest = `sha256:${createHash("sha256").update(retained, "utf8").digest("hex")}`;
  statements.createStatement.run(
    capsule.object_id,
    capsule.object_kind,
    capsule.schema_version,
    capsule.lifecycle_state,
    capsule.created_at,
    capsule.updated_at,
    capsule.created_by,
    capsule.evidence_kind,
    JSON.stringify(capsule.semantic_anchor),
    capsule.event_anchor === null ? null : JSON.stringify(capsule.event_anchor),
    capsule.physical_anchor === null ? null : JSON.stringify(capsule.physical_anchor),
    capsule.evidence_health_state,
    capsule.gist,
    capsule.excerpt,
    capsule.source_hash,
    capsule.run_id,
    capsule.workspace_id,
    capsule.surface_id,
    digest,
    Buffer.byteLength(retained, "utf8"),
    capsule.event_anchor?.occurred_at ?? null
  );
  if (sourceProvenance) {
    // Shared INSERT omits this later column so create still works before migration 027.
    db.connection.prepare(
      "UPDATE evidence_capsules SET source_provenance = 1 WHERE object_id = ?"
    ).run(capsule.object_id);
  }
  writeRetainedSourceChunks(db, { workspaceId: capsule.workspace_id, kind: "evidence_capsule",
    rootId: capsule.object_id, revision: capsule.updated_at, digest }, retained);
  for (const projection of searchProjections) {
    statements.createSearchProjectionStatement.run(
      capsule.object_id, projection.projection_id, projection.projection_kind,
      capsule.workspace_id, capsule.source_hash, projection.content
    );
  }
}
