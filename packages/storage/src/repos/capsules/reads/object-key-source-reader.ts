import type { StorageDatabase } from "../../../sqlite/db.js";
import { parseRows } from "../../shared/parse-row.js";
export interface StoredObjectKeyEvidenceSource {
  readonly object_id: string;
  readonly gist: string;
}

export function readObjectKeyEvidenceSources(
  db: StorageDatabase,
  workspaceId: string,
  evidenceIds: readonly string[]
): readonly StoredObjectKeyEvidenceSource[] {
  const ids = [...new Set(evidenceIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) return Object.freeze([]);
  const rows = parseRows(db.connection.prepare(`
    SELECT object_id, gist FROM evidence_capsules
    WHERE workspace_id = ? AND object_id IN (SELECT value FROM json_each(?))
  `).all(workspaceId, JSON.stringify(ids)), { parse: (value: unknown) => value as StoredObjectKeyEvidenceSource },
  "stored object key evidence source");
  const byId = new Map(rows.map((row) => [row.object_id, row]));
  return Object.freeze(ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  }));
}
