import { createHash } from "node:crypto";
import type { SqliteConnection } from "./db.js";
import { writeRetainedSourceChunks } from "../repos/field/retained-source-chunks.js";

/** Runs only inside the schema migration transaction, before publishing its ledger row. */
export function migrateRetainedSourceChunks(connection: SqliteConnection): void {
  migrateRecords(connection);
  migrateCapsules(connection);
}

function migrateRecords(connection: SqliteConnection): void {
  const read = connection.prepare(`SELECT workspace_id, record_id, source_version, content_digest, source_body
    FROM source_records WHERE (workspace_id, record_id) > (?, ?) ORDER BY workspace_id, record_id LIMIT 1`);
  const update = connection.prepare(`UPDATE source_records SET retained_content_bytes = ? WHERE workspace_id = ? AND record_id = ?`);
  let after = ["", ""];
  for (;;) {
    const row = read.get(...after) as { workspace_id: string; record_id: string; source_version: string; content_digest: string; source_body: string | null } | undefined;
    if (row === undefined) return;
    after = [row.workspace_id, row.record_id];
    if (row.source_body === null) continue;
    writeRetainedSourceChunks({ connection }, { workspaceId: row.workspace_id, kind: "source_record", rootId: row.record_id,
      revision: row.source_version, digest: row.content_digest }, row.source_body);
    update.run(Buffer.byteLength(row.source_body, "utf8"), row.workspace_id, row.record_id);
  }
}

function migrateCapsules(connection: SqliteConnection): void {
  const read = connection.prepare(`SELECT workspace_id, object_id, updated_at, gist, excerpt,
    json_extract(event_anchor, '$.occurred_at') AS event_time FROM evidence_capsules
    WHERE object_id > ? ORDER BY object_id LIMIT 1`);
  const update = connection.prepare(`UPDATE evidence_capsules SET retained_content_bytes = ?, retained_content_digest = ?,
    retained_source_event_time = ? WHERE workspace_id = ? AND object_id = ?`);
  let after = "";
  for (;;) {
    const row = read.get(after) as { workspace_id: string; object_id: string; updated_at: string; gist: string;
      excerpt: string | null; event_time: string | null } | undefined;
    if (row === undefined) return;
    after = row.object_id;
    const content = row.excerpt ?? row.gist;
    const digest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    writeRetainedSourceChunks({ connection }, { workspaceId: row.workspace_id, kind: "evidence_capsule", rootId: row.object_id,
      revision: row.updated_at, digest }, content);
    update.run(Buffer.byteLength(content, "utf8"), digest, row.event_time, row.workspace_id, row.object_id);
  }
}
