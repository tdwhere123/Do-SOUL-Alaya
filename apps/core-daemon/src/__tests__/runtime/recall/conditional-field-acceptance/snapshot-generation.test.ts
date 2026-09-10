import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type Continuation } from "@do-soul/alaya-protocol";
import { capableRecallConsumerDeclaration, RecallService } from "@do-soul/alaya-core";
import { initDatabase, initializeSemanticArtifactCandidateSchema, SqliteIndexedRecallProjection, type StorageDatabase } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../../runtime/recall-read-worker/observer-operations.js";
import { createRecallReadWorkerClient } from "../../../../runtime/recall/recall-read-worker-client.js";
import { createDependencies } from "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { openSourceSlice, WS, RUN, MEM } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";

const NOW = "2026-09-07T00:01:00.000Z";
const databases = new Set<StorageDatabase>();
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "alaya-snapshot-generation-")); directories.push(directory);
  const filename = join(directory, "source.sqlite");
  const slice = await openSourceSlice((db) => databases.add(db), filename);
  for (const id of [MEM.r, MEM.c, MEM.h]) await slice.writeMemory(id, "needle current source", MemoryDimension.FACT);
  slice.database.connection.prepare("UPDATE memory_entries SET updated_at = ? WHERE workspace_id = ?").run(NOW, WS);
  slice.database.connection.prepare("UPDATE event_log SET revision = 9999 WHERE entity_id = ? AND event_type = 'soul.memory.created'")
    .run(MEM.h);
  return { ...slice, filename };
}

function audit(database: StorageDatabase) {
  database.connection.prepare(`INSERT INTO event_log(event_id,event_type,entity_type,entity_id,workspace_id,run_id,
    caused_by,payload_json,created_at,revision) VALUES ('unrelated-audit','memory.delivered','trust_context_delivery',
    'unrelated',?,?,'test','{}',?,1000000)`).run(WS, RUN, NOW);
}

function request(service: RecallService, continuation: Continuation | null = null) {
  return service.recall({ ...capableRecallConsumerDeclaration(), workspaceId: WS, taskSurface: { display_name: "needle" }, strategy: "chat",
    continuation, budget: { schema_version: 1, work_units: 10000, memory_bytes: 1000000,
      page_budget: 1, finalization_reserve: 100, min_envelope: 1 } } as Parameters<RecallService["recall"]>[0]);
}

describe("workspace observable source generation", () => {
  for (const workerMode of [false, true]) {
    it.each(["content", "scope", "validity", "event_time", "tombstone"])(
      `invalidates same-timestamp %s mutations through real worker=${workerMode}`,
      async (mutation) => {
        const slice = await fixture();
        const readers = createConditionalFieldObserverReaders(slice.database);
        const worker = workerMode ? createRecallReadWorkerClient({ databaseFilename: slice.filename, workerCount: 1,
          workerUrl: new URL("../../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url) })! : undefined;
        try {
          await worker?.ready();
          const { dependencies } = createDependencies();
          const service = new RecallService({ ...dependencies, now: () => NOW,
            ...(worker ? { readSnapshot: worker.readSnapshot, conditionalFieldPort: worker.conditionalFieldPort }
              : { observerReaders: readers }) });
          const before = readers.snapshotPin!(WS);
          const first = await request(service);
          expect(first.index!.continuation).not.toBeNull();
          expect(first.execution_receipt).toMatchObject({
            workspace_id: WS,
            requested_budget: { schema_version: 1, work_units: 10000, memory_bytes: 1000000,
              page_budget: 1, finalization_reserve: 100, min_envelope: 1 },
            query_id: first.index!.query_id,
            interpretation_id: first.index!.interpretation_id,
            snapshot_id: first.index!.snapshot_id,
            interpretation_clock: NOW,
            compile_input: { text: "needle", snapshot_id: first.index!.snapshot_id,
              interpretation_clock: NOW }
          });
          expect(first.execution_receipt!.compile_input.budget.work_units).toBeLessThan(10000);
          audit(slice.database);
          slice.database.connection.prepare("UPDATE memory_entries SET content = content, valid_from = valid_from WHERE object_id = ?").run(MEM.c);
          expect(readers.snapshotPin!(WS)).toEqual(before);
          const unchanged = await request(service, first.index!.continuation);
          expect(unchanged.index!.completeness.logical_index).not.toBe("invalidated");
          expect(unchanged.index!.entries[0]?.object_id).not.toBe(first.index!.entries[0]?.object_id);
          const nativeBefore = slice.memoryReader.source(WS, MEM.c).row!;
          if (mutation === "content") await slice.memoryEntryRepo.update(MEM.c, { content: "removed match", updated_at: NOW });
          else if (mutation === "scope") slice.database.connection.prepare("UPDATE memory_entries SET scope_class = 'global_core' WHERE object_id = ?").run(MEM.c);
          else if (mutation === "validity") slice.database.connection.prepare("UPDATE memory_entries SET valid_to = ? WHERE object_id = ?").run(NOW, MEM.c);
          else if (mutation === "event_time") slice.database.connection.prepare("UPDATE memory_entries SET event_time_start = ? WHERE object_id = ?").run("2026-09-01T00:00:00.000Z", MEM.c);
          else slice.database.connection.prepare("UPDATE memory_entries SET lifecycle_state = 'tombstone' WHERE object_id = ?").run(MEM.c);
          const after = readers.snapshotPin!(WS);
          expect(after.applied_at).toBe(before.applied_at);
          expect(after.source_revision).not.toBe(before.source_revision);
          expect(slice.memoryReader.source(WS, MEM.c).row!.updated_at).toBe(NOW);
          if (mutation === "content") expect(slice.memoryReader.source(WS, MEM.c).row!.sourceRevision).not.toBe(nativeBefore.sourceRevision);
          const stale = await request(service, first.index!.continuation);
          expect(stale.index!.completeness.logical_index).toBe("invalidated");
          expect(stale.index!.entries).toEqual([]);
          const fresh = await request(service);
          expect(fresh.index!.snapshot_id).not.toBe(first.index!.snapshot_id);
          expect(fresh.execution_receipt!.snapshot_id).toBe(fresh.index!.snapshot_id);
          expect(fresh.execution_receipt!.snapshot_id).not.toBe(first.execution_receipt!.snapshot_id);
          expect(slice.database.connection.prepare("SELECT revision FROM event_log WHERE entity_id = ? AND event_type = 'soul.memory.created'")
            .get(MEM.h)).toEqual({ revision: 9999 });
        } finally { await worker?.close(); }
      }
    );
  }

  it("persists generation, rolls it back atomically, and rotates the epoch on cursor rebuild", async () => {
    const slice = await fixture();
    const pin = () => new SqliteIndexedRecallProjection(slice.database.connection).observablePin(WS);
    const before = pin();
    expect(() => slice.database.connection.transaction(() => {
      slice.database.connection.prepare("UPDATE memory_entries SET content = 'rolled back' WHERE object_id = ?").run(MEM.c);
      expect(pin().source_revision).not.toBe(before.source_revision);
      throw new Error("abort mutation");
    })()).toThrow("abort mutation");
    expect(pin()).toEqual(before);
    initializeSemanticArtifactCandidateSchema(slice.database.connection);
    expect(pin()).toEqual(before);
    slice.database.close(); databases.delete(slice.database);
    const reopened = initDatabase({ filename: slice.filename }); databases.add(reopened);
    initializeSemanticArtifactCandidateSchema(reopened.connection);
    const projection = new SqliteIndexedRecallProjection(reopened.connection);
    expect(projection.observablePin(WS)).toEqual(before);
    reopened.connection.prepare("DELETE FROM garden_projection_cursor WHERE workspace_id = ?").run(WS);
    const uninitialized = projection.observablePin(WS);
    expect(uninitialized.source_revision).not.toBe(before.source_revision);
    expect(projection.observablePin(WS)).toEqual(uninitialized);
    initializeSemanticArtifactCandidateSchema(reopened.connection);
    const rebuilt = projection.observablePin(WS);
    expect(rebuilt.source_revision).not.toBe(before.source_revision);
    expect(rebuilt.source_revision).not.toBe(uninitialized.source_revision);
    expect(projection.observablePin(WS)).toEqual(rebuilt);
    expect(rebuilt.applied_at).toBe(before.applied_at);
    expect(reopened.connection.prepare("SELECT revision FROM garden_semantic_schema").all()).toEqual([{ revision: 6 }]);
  });

  it("observes same-time embedding model and semantic publication changes", async () => {
    const slice = await fixture();
    const pin = () => new SqliteIndexedRecallProjection(slice.database.connection).observablePin(WS).source_revision;
    let prior = pin();
    slice.database.connection.prepare(`INSERT INTO memory_embeddings(object_id,workspace_id,content_hash,provider_kind,
      model_id,schema_version,dimensions,embedding_blob,created_at,updated_at,vector_valid)
      VALUES (?,?,'hash','test','model-a',1,1,?,?,?,1)`).run(MEM.c, WS, Buffer.alloc(4), NOW, NOW);
    expect(pin()).not.toBe(prior); prior = pin();
    slice.database.connection.prepare("UPDATE memory_embeddings SET model_id='model-b' WHERE object_id=?").run(MEM.c);
    expect(pin()).not.toBe(prior); prior = pin();
    slice.database.connection.prepare("UPDATE memory_embeddings SET model_id=model_id WHERE object_id=?").run(MEM.c);
    expect(pin()).toBe(prior);
    slice.database.connection.prepare(`INSERT INTO garden_semantic_projections(workspace_id,object_id,source_revision,
      publication_key,task_id,source_content,search_text,published_at,source_evidence_refs,source_updated_at,source_event_revision)
      VALUES (?,?,'source','publication','task','needle','semantic-a',?,'[]',?,0)`).run(WS, MEM.c, NOW, NOW);
    expect(pin()).not.toBe(prior); prior = pin();
    slice.database.connection.prepare("UPDATE garden_semantic_projections SET search_text='semantic-b' WHERE object_id=?").run(MEM.c);
    expect(pin()).not.toBe(prior); prior = pin();
    slice.database.connection.prepare("DELETE FROM garden_semantic_projections WHERE object_id=?").run(MEM.c);
    expect(pin()).not.toBe(prior); prior = pin();
    slice.database.connection.prepare("DELETE FROM memory_embeddings WHERE object_id=?").run(MEM.c);
    expect(pin()).not.toBe(prior);
  });

  it("upgrades a persisted schema5 cursor without redefining its event revision", async () => {
    const slice = await fixture();
    const cursor = slice.database.connection.prepare("SELECT applied_event_revision FROM garden_projection_cursor WHERE workspace_id=?")
      .get(WS);
    const triggers = slice.database.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'garden_observable_%'")
      .all() as { name: string }[];
    for (const trigger of triggers) slice.database.connection.exec(`DROP TRIGGER ${trigger.name}`);
    slice.database.connection.exec(`ALTER TABLE garden_projection_cursor DROP COLUMN observable_generation;
      ALTER TABLE garden_projection_cursor DROP COLUMN observable_epoch;
      UPDATE garden_semantic_schema SET revision=5;`);
    initializeSemanticArtifactCandidateSchema(slice.database.connection);
    expect(slice.database.connection.prepare("SELECT revision FROM garden_semantic_schema").all()).toEqual([{ revision: 6 }]);
    expect(slice.database.connection.prepare("SELECT applied_event_revision FROM garden_projection_cursor WHERE workspace_id=?").get(WS)).toEqual(cursor);
    const projection = new SqliteIndexedRecallProjection(slice.database.connection);
    const before = projection.observablePin(WS);
    expect(before.source_revision.length).toBeGreaterThan(0);
    expect(projection.observablePin(WS)).toEqual(before);
    expect(slice.database.connection.prepare("SELECT observable_generation FROM garden_projection_cursor WHERE workspace_id=?")
      .get(WS)).toEqual({ observable_generation: 0 });
    slice.database.connection.prepare("UPDATE memory_entries SET valid_from=? WHERE object_id=?").run(NOW, MEM.c);
    expect(projection.observablePin(WS).source_revision).not.toBe(before.source_revision);
  });
});
