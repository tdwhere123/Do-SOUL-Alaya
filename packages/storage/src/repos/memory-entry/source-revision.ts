import { createHash } from "node:crypto";

export const MEMORY_SOURCE_REVISION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS garden_semantic_source_event_revision
  ON event_log(workspace_id, entity_type, entity_id, revision DESC)
  WHERE event_type IN ('soul.memory.created','soul.memory.updated')`;

export function memorySourceRevision(eventRevision: number, content: string, evidenceRefsJson: string, updatedAt: string): string {
  return createHash("sha256").update(JSON.stringify([eventRevision, content, evidenceRefsJson, updatedAt]), "utf8").digest("hex");
}
