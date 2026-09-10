import type { StorageDatabase } from "../../../sqlite/db.js";
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
      CASE WHEN lifecycle_state != 'active' THEN 1 ELSE EXISTS (
        SELECT 1 FROM source_record_evidence_refs ref JOIN source_records r
          ON r.workspace_id = ref.workspace_id AND r.record_id = ref.record_id
        WHERE ref.workspace_id = e.workspace_id AND ref.evidence_object_id = e.object_id
          AND ref.record_id = (SELECT active.record_id FROM source_record_active_evidence_refs active
            WHERE active.workspace_id = e.workspace_id AND active.evidence_object_id = e.object_id
            ORDER BY active.record_id LIMIT 1) AND octet_length(r.source_body) IS NOT NULL LIMIT 1
      ) END AS linked
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
