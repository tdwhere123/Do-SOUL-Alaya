import { createHistoricalMemoryCapture, EventLogEntrySchema, SoulMemoryStateChangedPayloadSchema, type MemoryEntry,
  type SynthesisCapsule } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";
import { SqliteSynthesisCapsuleRepo } from "../../../repos/capsules/synthesis-capsule-repo.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { putSourceStatementMemoryBinding } from "../../../repos/source-index/statement-dependencies.js";
import { publishMessages, publishStatement } from "../source-index/source-template-fixture.js";
import { fieldSha256 } from "../field/field-contract-fixture.js";
import { createMemoryEntry, createRepo } from "./memory-entry-repo-fixture.js";

const CLOCK = "2020-01-01T00:00:00.000Z";
/** Storage mechanics fixture: real source/artifact/binding, canonical proof and atomic transition audit.
 * The daemon suite independently verifies the supported Core publication and native sweep producer chain.
 */
export async function seedHistoricalMember(database: StorageDatabase, repo: SqliteMemoryEntryRepo,
  memoryId: string, capsuleId: string) {
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const source = publishMessages({ database, records }, [{ role: "user", text: "Exact retained statement." }], memoryId);
  const statement = publishStatement({ database }, source, memoryId);
  const artifactId = statement.source.auxiliary!.artifact_id;
  await repo.create(createMemoryEntry({ object_id: memoryId, lifecycle_state: "dormant", retention_state: "working",
    dimension: "observation", source_kind: "compiler", formation_kind: "extracted", content: statement.bound.statement.text,
    evidence_refs: [artifactId], updated_at: CLOCK }));
  database.connection.transaction(() => putSourceStatementMemoryBinding(database, "workspace-1", memoryId, artifactId))();
  await new SqliteSynthesisCapsuleRepo(database).create({ object_id: capsuleId, object_kind: "synthesis_capsule",
    schema_version: 1, lifecycle_state: "active", created_at: CLOCK, updated_at: CLOCK, created_by: "deterministic_rule",
    topic_key: "historical retention", synthesis_type: "cross_evidence", summary: "Incomplete summary.", evidence_refs: [],
    source_memory_refs: [memoryId], workspace_id: "workspace-1", run_id: "run-1", synthesis_status: "stable" });
  const nomination = await repo.readHistoricalCaptureCandidate("workspace-1", memoryId, capsuleId);
  if (nomination.status !== "ready") throw new Error("native fixture capture unavailable");
  const preservation = createHistoricalMemoryCapture(nomination.candidate, CLOCK, fieldSha256);
  if (preservation === null) throw new Error("fixture does not satisfy historical capture contract");
  const events = new SqliteEventLogRepo(database);
  await repo.autonomousTombstone({ objectId: memoryId, disposition: "compressed", dispositionRef: capsuleId,
    updatedAt: CLOCK, preservation }, { onTransition: () => EventLogEntrySchema.parse(events.append({ event_type: "soul.memory.state_changed",
    entity_type: "memory_entry", entity_id: memoryId, workspace_id: "workspace-1", run_id: "run-1", caused_by: "deterministic_rule",
    payload_json: SoulMemoryStateChangedPayloadSchema.parse({ object_id: memoryId, object_kind: "memory_entry",
      workspace_id: "workspace-1", run_id: "run-1", from_state: "dormant", to_state: "tombstone", occurred_at: CLOCK,
      caused_by: "deterministic_rule", reason_code: "historical retention fixture", evidence_refs: [capsuleId],
      preservation: { schema_version: 1, capture_id: preservation.capture_id, capsule_id: capsuleId } }) })) });
}

export async function seedCompressedMember(input: { readonly memoryId: string; readonly capsuleId: string;
  readonly capsule: Partial<SynthesisCapsule> | null; readonly memory?: Partial<MemoryEntry> }) {
  const { repo, database } = await createRepo();
  await seedHistoricalMember(database, repo, input.memoryId, input.capsuleId);
  if (input.capsule === null) database.connection.prepare("DELETE FROM synthesis_capsules WHERE object_id=?").run(input.capsuleId);
  else {
    const capsule = input.capsule;
    if (capsule.synthesis_status === "archived" || capsule.lifecycle_state === "tombstone") {
      database.connection.prepare("UPDATE synthesis_capsules SET synthesis_status='archived',lifecycle_state='tombstone',topic_key='erased',summary='erased' WHERE object_id=?")
        .run(input.capsuleId);
    }
    if (capsule.source_memory_refs !== undefined) database.connection.prepare("UPDATE synthesis_capsules SET source_memory_refs=? WHERE object_id=?")
      .run(JSON.stringify(capsule.source_memory_refs), input.capsuleId);
  }
  if (input.memory?.decay_profile !== undefined) database.connection.prepare("UPDATE memory_entries SET decay_profile=? WHERE object_id=?")
    .run(input.memory.decay_profile, input.memoryId);
  if (input.memory?.retention_state !== undefined) database.connection.prepare("UPDATE memory_entries SET retention_state=? WHERE object_id=?")
    .run(input.memory.retention_state, input.memoryId);
  return { repo, database };
}
