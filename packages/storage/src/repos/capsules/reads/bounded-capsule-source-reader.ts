import type { StorageDatabase } from "../../../sqlite/db.js";
import { cachedReadStatement } from "../../../sqlite/dynamic-prepared-statement-cache.js";
import { readRetainedSourceChunk } from "../../field/retained-source-chunks.js";

export type BoundedCapsuleSource = Readonly<{
  object_id: string;
  workspace_id: string;
  updated_at: string;
  created_at: string;
  event_time: string | null;
  retained_extent: "excerpt" | "gist";
  digest: string | null;
  body_bytes: number | null;
  prefix: Buffer | null;
  chunkEnd?: number;
  nativeBytes: number;
  metadataBytes?: number;
  linked: number;
}>;

const METADATA = ["object_id", "workspace_id", "updated_at", "created_at", "retained_source_event_time", "retained_content_digest"];
const METADATA_BYTES = METADATA.map((column) => `COALESCE(octet_length(${column}), 0)`).join(" + ");
const bounded = (column: string): string => `CASE WHEN (${METADATA_BYTES}) <= 8120 THEN ${column} ELSE NULL END`;
const COLUMNS = `${["object_id", "workspace_id", "updated_at", "created_at"].map((column) => `${bounded(column)} AS ${column}`).join(",")},
  ${bounded("retained_source_event_time")} AS event_time,
  CASE WHEN octet_length(excerpt) IS NULL THEN 'gist' ELSE 'excerpt' END AS retained_extent,
  ${bounded("retained_content_digest")} AS digest,
  CASE WHEN retained_content_bytes = COALESCE(octet_length(excerpt), octet_length(gist))
    THEN retained_content_bytes ELSE NULL END AS body_bytes`;

/** Bound evidence aliases and persisted provenance excerpts are not standalone roots. */
const EXCLUDED_CAPSULE = `CASE WHEN lifecycle_state != 'active' OR source_provenance = 1 THEN 1 ELSE EXISTS (
  SELECT 1 FROM source_record_evidence_refs ref JOIN source_records r
    ON r.workspace_id = ref.workspace_id AND r.record_id = ref.record_id
  WHERE ref.workspace_id = e.workspace_id AND ref.evidence_object_id = e.object_id
    AND ref.record_id = (SELECT active.record_id FROM source_record_active_evidence_refs active
      WHERE active.workspace_id = e.workspace_id AND active.evidence_object_id = e.object_id
      ORDER BY active.record_id LIMIT 1) AND octet_length(r.source_body) IS NOT NULL LIMIT 1
) END`;

/** Reads one indexed candidate before applying capsule-only membership. */
export class BoundedCapsuleSourceReader {
  public constructor(private readonly database: StorageDatabase) {}

  public read(workspaceId: string, objectId: string, byteLimit: number, offset: number): BoundedCapsuleSource | null {
    this.validate(byteLimit, offset);
    const row = this.database.connection.prepare(`SELECT ${COLUMNS}, 0 AS linked
      FROM evidence_capsules WHERE workspace_id = $workspace AND object_id = $id
        AND lifecycle_state = 'active' LIMIT 1`).get({
      workspace: workspaceId, id: objectId
    }) as BoundedCapsuleSource | undefined ?? null;
    return row === null ? null : this.withBody(row, byteLimit, offset);
  }

  public readTargetAvailability(workspaceId: string, objectId: string): "ok" | "not_found" | "erased_or_quarantined" {
    const row = cachedReadStatement(this.database, `SELECT
      lifecycle_state,
      EXISTS(
        SELECT 1 FROM privacy_current_quarantine q
        WHERE q.workspace_id = evidence_capsules.workspace_id
          AND q.object_kind = 'evidence_capsule' AND q.object_id = evidence_capsules.object_id
      ) AS quarantined
      FROM evidence_capsules WHERE workspace_id = ? AND object_id = ? LIMIT 1`).get(workspaceId, objectId) as
      { lifecycle_state: string; quarantined: number } | undefined;
    if (row === undefined) return "not_found";
    return row.lifecycle_state !== "active" || row.quarantined === 1 ? "erased_or_quarantined" : "ok";
  }

  /** Same standalone membership as capture, without changing direct retained-target reads. */
  public readCandidate(workspaceId: string, objectId: string, byteLimit: number): BoundedCapsuleSource | null {
    this.validate(byteLimit, 0);
    const row = this.database.connection.prepare(`SELECT ${COLUMNS}, ${EXCLUDED_CAPSULE} AS linked
      FROM evidence_capsules e WHERE workspace_id=? AND object_id=? LIMIT 1`)
      .get(workspaceId, objectId) as BoundedCapsuleSource | undefined;
    if (row === undefined) return null;
    return row.linked === 1 ? { ...row, prefix: null, nativeBytes: 0 } : this.withBody(row, byteLimit, 0);
  }

  public page(workspaceId: string, after: { afterCreatedAt: string | null; afterObjectId: string | null },
    limit: number, byteLimit: number): readonly BoundedCapsuleSource[] {
    this.validate(byteLimit, 0);
    // LIMIT selects physical candidates. Filtering inside it would hide a scan
    // through arbitrarily many linked or inactive capsules behind one visit.
    const rows = this.database.connection.prepare(`WITH candidates AS MATERIALIZED (
      SELECT object_id FROM evidence_capsules
      WHERE workspace_id = $workspace AND (created_at, object_id) > ($created, $id)
      ORDER BY created_at, object_id LIMIT $limit
    ) SELECT ${COLUMNS},
      ${EXCLUDED_CAPSULE} AS linked
    FROM candidates c JOIN evidence_capsules e USING (object_id)
    ORDER BY created_at, object_id`).all({
      workspace: workspaceId, created: after.afterCreatedAt ?? "", id: after.afterObjectId ?? "",
      limit
    }) as readonly BoundedCapsuleSource[];
    return rows.map((row) => row.linked === 1 ? { ...row, prefix: null, nativeBytes: 0 } : this.withBody(row, byteLimit, 0));
  }

  private withBody(row: BoundedCapsuleSource, byteLimit: number, offset: number): BoundedCapsuleSource {
    if (row.digest === null || row.body_bytes === null) return { ...row, prefix: null, nativeBytes: 0 };
    return { ...row, ...readRetainedSourceChunk(this.database, { workspaceId: row.workspace_id, kind: "evidence_capsule",
      rootId: row.object_id, revision: row.updated_at, digest: row.digest }, offset, byteLimit, row.body_bytes) };
  }

  private validate(byteLimit: number, offset: number): void {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 65_536
      || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid capsule source byte range");
  }
}
