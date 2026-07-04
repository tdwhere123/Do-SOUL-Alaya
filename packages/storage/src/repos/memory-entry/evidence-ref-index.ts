import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { SqliteRunStatement } from "./statement-types.js";

export interface MemoryEntryEvidenceRefIndexHost {
  readonly deleteEvidenceRefsByMemoryStatement: SqliteRunStatement;
  readonly insertEvidenceRefStatement: SqliteRunStatement;
}

export function syncMemoryEntryEvidenceRefIndex(
  host: MemoryEntryEvidenceRefIndexHost,
  entry: Readonly<MemoryEntry>
): void {
  deleteMemoryEntryEvidenceRefIndex(host, entry.object_id);
  for (const evidenceRef of uniqueEvidenceRefs(entry.evidence_refs)) {
    host.insertEvidenceRefStatement.run(entry.workspace_id, entry.object_id, evidenceRef);
  }
}

export function deleteMemoryEntryEvidenceRefIndex(
  host: MemoryEntryEvidenceRefIndexHost,
  objectId: string
): void {
  host.deleteEvidenceRefsByMemoryStatement.run(objectId);
}

function uniqueEvidenceRefs(evidenceRefs: readonly string[]): readonly string[] {
  return [...new Set(evidenceRefs.filter((evidenceRef) => evidenceRef.length > 0))];
}
