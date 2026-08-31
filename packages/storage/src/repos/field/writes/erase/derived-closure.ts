import type { StorageDatabase } from "../../../../sqlite/db.js";
import {
  parseRows,
  readNonEmptyStringField,
  readRecord,
  type RowParser
} from "../../../shared/parse-row.js";
import type { FieldEraseBarrierRow } from "../../ports.js";

const idParser: RowParser<string> = {
  parse(value: unknown): string {
    return readNonEmptyStringField(readRecord(value, "privacy erase derived object"), "object_id");
  }
};

export function scrubDerivedPrivacyClosure(
  database: StorageDatabase,
  barrier: FieldEraseBarrierRow,
  evidenceIds: readonly string[]
): void {
  const memoryIds = findLinkedMemoryIds(database, barrier.workspace_id, evidenceIds);
  const synthesisIds = findLinkedSynthesisIds(
    database,
    barrier.workspace_id,
    evidenceIds,
    memoryIds
  );
  scrubSynthesisCapsules(database, barrier, synthesisIds);
  scrubMemoryEntries(database, barrier, memoryIds);
}

function findLinkedMemoryIds(
  database: StorageDatabase,
  workspaceId: string,
  evidenceIds: readonly string[]
): readonly string[] {
  const statement = database.connection.prepare(`
    SELECT memory_id AS object_id FROM memory_entry_evidence_refs
    WHERE workspace_id = ? AND evidence_ref = ? ORDER BY memory_id
  `);
  return uniqueIds(evidenceIds.flatMap((evidenceId) =>
    parseRows(statement.all(workspaceId, evidenceId), idParser, "privacy erase memory")
  ));
}

function findLinkedSynthesisIds(
  database: StorageDatabase,
  workspaceId: string,
  evidenceIds: readonly string[],
  memoryIds: readonly string[]
): readonly string[] {
  const byEvidence = database.connection.prepare(`
    SELECT object_id FROM synthesis_capsules
    WHERE workspace_id = ? AND EXISTS (
      SELECT 1 FROM json_each(evidence_refs) WHERE value = ?
    ) ORDER BY object_id
  `);
  const byMemory = database.connection.prepare(`
    SELECT object_id FROM synthesis_capsules
    WHERE workspace_id = ? AND EXISTS (
      SELECT 1 FROM json_each(source_memory_refs) WHERE value = ?
    ) ORDER BY object_id
  `);
  return uniqueIds([
    ...evidenceIds.flatMap((id) =>
      parseRows(byEvidence.all(workspaceId, id), idParser, "privacy erase synthesis evidence")
    ),
    ...memoryIds.flatMap((id) =>
      parseRows(byMemory.all(workspaceId, id), idParser, "privacy erase synthesis memory")
    )
  ]);
}

function scrubMemoryEntries(
  database: StorageDatabase,
  barrier: FieldEraseBarrierRow,
  memoryIds: readonly string[]
): void {
  const connection = database.connection;
  const deletes = [
    "DELETE FROM main.memory_embeddings WHERE workspace_id = ? AND object_id = ?",
    "DELETE FROM memory_object_keys WHERE workspace_id = ? AND owner_id = ?",
    "DELETE FROM recall_routing_key_owners WHERE workspace_id = ? AND owner_id = ?"
  ].map((sql) => connection.prepare(sql));
  const scrubHq = connection.prepare(
    "UPDATE memory_hq SET hqs_json = '[]', updated_at = ? WHERE workspace_id = ? AND object_id = ?"
  );
  const scrubObservations = connection.prepare(`
    UPDATE memory_hq_observations
    SET hqs_json = '[]', hq_content_sha256 = 'erased', observation_sha256 = 'erased'
    WHERE workspace_id = ? AND object_id = ?
  `);
  const scrubMemory = connection.prepare(`
    UPDATE memory_entries
    SET content = 'erased', domain_tags = '[]', lifecycle_state = 'tombstone',
        retention_state = 'tombstoned', manifestation_state = NULL,
        preference_subject = NULL, preference_predicate = NULL,
        preference_object = NULL, preference_category = NULL,
        preference_polarity = NULL, facet_tags = NULL, canonical_entities = NULL,
        updated_at = ?
    WHERE workspace_id = ? AND object_id = ?
  `);
  for (const memoryId of memoryIds) {
    for (const statement of deletes) statement.run(barrier.workspace_id, memoryId);
    scrubObservations.run(barrier.workspace_id, memoryId);
    scrubHq.run(barrier.erased_at, barrier.workspace_id, memoryId);
    scrubMemory.run(barrier.erased_at, barrier.workspace_id, memoryId);
  }
}

function scrubSynthesisCapsules(
  database: StorageDatabase,
  barrier: FieldEraseBarrierRow,
  synthesisIds: readonly string[]
): void {
  const removeRouting = database.connection.prepare(
    "DELETE FROM recall_routing_key_owners WHERE workspace_id = ? AND owner_id = ?"
  );
  const scrub = database.connection.prepare(`
    UPDATE synthesis_capsules
    SET lifecycle_state = 'tombstone', synthesis_status = 'archived',
        topic_key = 'erased', summary = 'erased', updated_at = ?
    WHERE workspace_id = ? AND object_id = ?
  `);
  for (const synthesisId of synthesisIds) {
    removeRouting.run(barrier.workspace_id, synthesisId);
    scrub.run(barrier.erased_at, barrier.workspace_id, synthesisId);
  }
}

function uniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}
