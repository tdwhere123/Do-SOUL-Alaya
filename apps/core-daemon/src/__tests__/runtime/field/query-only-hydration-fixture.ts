import { afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  MemoryService
} from "@do-soul/alaya-core";
import {
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo,
  prepareIndexedRecallProjection,
  StorageDatabase
} from "@do-soul/alaya-storage";
import { applySqliteWritePragmas } from
  "../../../../../../packages/storage/src/sqlite/apply-sqlite-write-pragmas.js";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";
import { createBoundRecallPathReadPorts } from
  "../../../runtime/recall/recall-path-read-bind.js";
import {
  createWorkerMemoryRepo,
  type WorkerTierWindowResult
} from "../../../runtime/recall-read-worker/memory-client.js";
import { runOperation } from "../../../runtime/recall-read-worker/dispatch.js";
import {
  RECALL_READ_WORKER_PROTOCOL_VERSION,
  type RecallReadWorkerOperation
} from "../../../runtime/recall-read-worker/protocol.js";
import type { RecallReadWorkerRuntime } from
  "../../../runtime/recall-read-worker/runtime.js";
import {
  CLOCK,
  EVIDENCE_ID,
  MEMORY_ID,
  WORKSPACE_ID,
  composeField,
  createPlantedHarness,
  memoryEntry,
  persistMemory,
  produceAdaSource,
  realMemoryRepo
} from "./source-field-harness.js";

export const LIVE_B_ID = "22222222-2222-4222-8222-222222222222";
export const TOMBSTONE_ID = "33333333-3333-4333-8333-333333333333";
export const JSON_ONLY_ID = "44444444-4444-4444-8444-444444444444";
export const INDEX_ONLY_ID = "55555555-5555-4555-8555-555555555555";
export const DORMANT_ID = "66666666-6666-4666-8666-666666666666";
export const MISSING_ID = "99999999-9999-4999-8999-999999999999";

export function createQueryOnlyHydrationHarness() {
  const planted = createPlantedHarness();
  const queryOnlyHandles = new Set<StorageDatabase>();
  afterEach(() => {
    for (const database of queryOnlyHandles) closeQueryOnlyHandle(database);
    queryOnlyHandles.clear();
  });
  return {
    planted,
    openQueryOnlyPair(filename = planted.createTempFilename(), seed = true) {
      const writer = planted.openDatabase(filename, { seed });
      prepareIndexedRecallProjection(writer);
      const queryOnly = openQueryOnlyDatabase(filename, queryOnlyHandles);
      return {
        writer,
        queryOnly,
        queryOnlyRuntime: createQueryOnlyRuntime(queryOnly)
      };
    },
    async openHydrationFixture() {
      return await openHydrationFixture(planted, queryOnlyHandles);
    }
  };
}

export async function persistConditionalSource(database: StorageDatabase, objectId: string, content: string) {
  prepareIndexedRecallProjection(database);
  const evidence = new SqliteEvidenceCapsuleRepo(database);
  const service = new MemoryService({
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    eventLogRepo: new SqliteEventLogRepo(database),
    now: () => CLOCK,
    generateObjectId: () => objectId,
    evidenceService: {
      findById: (id) => evidence.findById(id),
      findByIds: (workspaceId, ids) => evidence.findByIds(workspaceId, ids)
    },
    runtimeNotifier: { notifyEntry: async () => {} }
  });
  return service.create({ created_by: "user_action", dimension: "fact", source_kind: "user",
    formation_kind: "explicit", scope_class: "project", content, domain_tags: [], evidence_refs: [],
    workspace_id: WORKSPACE_ID, run_id: "run-1", surface_id: null });
}

export function conditionalRecallPayload(queryText: string) {
  return { workspace_id: WORKSPACE_ID, query_text: queryText,
    snapshot_id: `sha256:${"c".repeat(64)}`,
    interpretation_clock: CLOCK, as_of: CLOCK, lifetime_now: CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    budget: { schema_version: 1 as const, work_units: 10_000, memory_bytes: 1_000_000,
      page_budget: 100, finalization_reserve: 100, min_envelope: 10 },
    protocol_version: 1 as const,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true,
    supports_product_updates: true,
    authorized_scopes: null };
}

async function openHydrationFixture(
  planted: ReturnType<typeof createPlantedHarness>,
  queryOnlyHandles: Set<StorageDatabase>
) {
  const filename = planted.createTempFilename();
  const formation = planted.openDatabase(filename, { seed: true });
  await produceAdaSource(formation, composeField(formation).stores, "ada");
  await persistHydrationMemories(formation);
  planted.close(formation);
  const writer = planted.openDatabase(filename);
  prepareIndexedRecallProjection(writer);
  const queryOnly = openQueryOnlyDatabase(filename, queryOnlyHandles);
  const field = composeField(writer);
  const queryOnlyRuntime = createQueryOnlyRuntime(queryOnly);
  return {
    writer,
    queryOnly,
    field,
    directRepo: realMemoryRepo(writer),
    queryOnlyRuntime,
    dispatchedMemoryPort: createDispatchedMemoryPort(queryOnlyRuntime)
  };
}

function openQueryOnlyDatabase(
  filename: string,
  handles: Set<StorageDatabase>
): StorageDatabase {
  const connection = new BetterSqlite3(filename);
  applySqliteWritePragmas(connection, {
    busyTimeoutMs: 5_000,
    analysisLimit: 400
  });
  connection.pragma("query_only = ON");
  const database = new StorageDatabase(filename, connection);
  handles.add(database);
  return database;
}

function closeQueryOnlyHandle(database: StorageDatabase): void {
  // StorageDatabase.close() evicts the writer cache entry for this filename.
  const connection = database.connection;
  if (connection.open) connection.close();
}

export function createQueryOnlyRuntime(database: StorageDatabase): RecallReadWorkerRuntime {
  return {
    database,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(
      database,
      verifyOfficialApiSourceLocatorBinding
    ),
    synthesisCapsuleRepo: new SqliteSynthesisCapsuleRepo(database),
    claimFormRepo: new SqliteClaimFormRepo(database),
    recallPathReadPorts: createBoundRecallPathReadPorts({ database }),
    closed: false
  };
}

export async function dispatchQueryOnly(
  runtime: RecallReadWorkerRuntime,
  operation: RecallReadWorkerOperation,
  payload: unknown
): Promise<unknown> {
  const request = structuredClone({
    protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
    id: 1,
    operation,
    payload
  });
  return structuredClone(await runOperation(runtime, request));
}

function createDispatchedMemoryPort(runtime: RecallReadWorkerRuntime) {
  return createWorkerMemoryRepo({
    request: async <Result>(operation: string, payload: unknown): Promise<Result> =>
      await dispatchQueryOnly(runtime, operation as never, payload) as Result,
    readTierWindow: async (query) =>
      await dispatchQueryOnly(runtime, "memory.findRecallTierWindow", query) as WorkerTierWindowResult
  });
}

async function persistHydrationMemories(database: StorageDatabase): Promise<void> {
  await persistMemory(database, memoryEntry());
  await persistMemory(database, memoryEntry({
    object_id: LIVE_B_ID,
    content: "Sealed second binder."
  }));
  await persistOmittedHydrationMemories(database);
  plantEvidenceRefMismatch(database);
}

async function persistOmittedHydrationMemories(database: StorageDatabase): Promise<void> {
  await persistMemory(database, memoryEntry({
    object_id: TOMBSTONE_ID,
    content: "Tombstoned binder.",
    retention_state: "tombstoned"
  }));
  await persistMemory(database, memoryEntry({
    object_id: JSON_ONLY_ID,
    content: "JSON-only binder."
  }));
  await persistMemory(database, memoryEntry({
    object_id: INDEX_ONLY_ID,
    content: "Index-only binder.",
    evidence_refs: []
  }));
  await persistMemory(database, memoryEntry({
    object_id: DORMANT_ID,
    content: "Dormant binder.",
    lifecycle_state: "dormant"
  }));
}

function plantEvidenceRefMismatch(database: StorageDatabase): void {
  database.connection.prepare(
    "DELETE FROM memory_entry_evidence_refs WHERE memory_id = ?"
  ).run(JSON_ONLY_ID);
  database.connection.prepare(`
    INSERT OR IGNORE INTO memory_entry_evidence_refs(workspace_id, memory_id, evidence_ref)
    VALUES (?, ?, ?)
  `).run(WORKSPACE_ID, INDEX_ONLY_ID, EVIDENCE_ID);
}
