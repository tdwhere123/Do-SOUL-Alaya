import { afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  QUERY_CONDITION_OPERATOR_ID,
  hashConditionDigest,
  hashQueryCacheKey,
  verifyQueryConditionReceipt,
  type ProjectionPin
} from "@do-soul/alaya-protocol";
import {
  fieldContractSha256,
  type RecallService
} from "@do-soul/alaya-core";
import {
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo,
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
import type { RecallReadWorkerOperation } from
  "../../../runtime/recall-read-worker/protocol.js";
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
  realMemoryRepo,
  type PlantedField
} from "./p217-planted-harness.js";

export const LIVE_B_ID = "22222222-2222-4222-8222-222222222222";
export const TOMBSTONE_ID = "33333333-3333-4333-8333-333333333333";
export const JSON_ONLY_ID = "44444444-4444-4444-8444-444444444444";
export const INDEX_ONLY_ID = "55555555-5555-4555-8555-555555555555";
export const DORMANT_ID = "66666666-6666-4666-8666-666666666666";
export const MISSING_ID = "99999999-9999-4999-8999-999999999999";
export const UNBOUND_EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OMITTED_MEMORY_IDS = [
  TOMBSTONE_ID,
  JSON_ONLY_ID,
  INDEX_ONLY_ID,
  DORMANT_ID
] as const;

export function createQueryOnlyHydrationHarness() {
  const planted = createPlantedHarness();
  const queryOnlyHandles = new Set<StorageDatabase>();
  afterEach(() => {
    for (const database of queryOnlyHandles) closeQueryOnlyHandle(database);
    queryOnlyHandles.clear();
  });
  return {
    planted,
    openQueryOnlyPair(filename = planted.createTempFilename()) {
      const writer = planted.openDatabase(filename, { seed: true });
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

function createQueryOnlyRuntime(database: StorageDatabase): RecallReadWorkerRuntime {
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
  const request = structuredClone({ id: 1, operation, payload });
  return structuredClone(await runOperation(runtime, request));
}

function createDispatchedMemoryPort(runtime: RecallReadWorkerRuntime) {
  return createWorkerMemoryRepo({
    request: async <Result>(operation, payload): Promise<Result> =>
      await dispatchQueryOnly(runtime, operation, payload) as Result,
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

export function selectAdaEvidenceIds(
  querySession: PlantedField["querySession"]
): readonly string[] {
  const pin = querySession.pinActiveGeneration(WORKSPACE_ID, CLOCK);
  try {
    return querySession.selectCandidates(adaQueryCondition(pin), pin, CLOCK).candidate_keys;
  } finally {
    querySession.release(pin, CLOCK);
  }
}

function adaQueryCondition(pin: ProjectionPin) {
  const condition = {
    principal: WORKSPACE_ID,
    workspace_id: WORKSPACE_ID,
    authorized_scopes: [WORKSPACE_ID],
    explicit_bridges: [] as const,
    workspace_project: WORKSPACE_ID,
    effective_as_of: CLOCK,
    query_task_factors: ["Ada"] as const,
    governance_state: "open" as const,
    activation_budget: 8,
    token_budget: 256
  };
  const identity = hashConditionDigest(condition, fieldContractSha256);
  return verifyQueryConditionReceipt({
    schema_version: 1,
    producer: QUERY_CONDITION_OPERATOR_ID,
    consumer: "attributed_activation",
    identity,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "none",
    deletion_behavior: "rebuildable",
    condition,
    generation_id: pin.generation_id,
    query_operator_id: QUERY_CONDITION_OPERATOR_ID,
    query_cache_key: hashQueryCacheKey({
      generation_id: pin.generation_id,
      condition_digest: identity,
      query_operator_id: QUERY_CONDITION_OPERATOR_ID
    }, fieldContractSha256),
    recorded_at: CLOCK
  }, fieldContractSha256);
}

export function fieldRecallContract(
  result: Awaited<ReturnType<RecallService["recall"]>>
) {
  const trace = result.diagnostics?.field_projection_trace;
  return {
    membership: result.candidates.map((candidate) => candidate.object_id),
    field_projection_ids: fieldProjectionIds(result),
    source_channels: result.candidates.map((candidate) => ({
      object_id: candidate.object_id,
      source_channels: candidate.source_channels
    })),
    admission_planes: (result.diagnostics?.candidates ?? []).map((candidate) => ({
      object_id: candidate.object_id,
      admission_planes: candidate.admission_planes
    })),
    candidate_keys: trace?.candidate_keys ?? [],
    receipts: trace?.candidate_receipts,
    activation: trace?.activation
  };
}

export function fieldProjectionIds(
  result: Awaited<ReturnType<RecallService["recall"]>>
): readonly string[] {
  return result.candidates
    .filter((candidate) => candidate.source_channels?.includes("field_projection"))
    .map((candidate) => candidate.object_id);
}

export function selectWithUnboundEvidence(
  session: PlantedField["querySession"]
): PlantedField["querySession"] {
  return {
    ...session,
    selectCandidates(condition, pin, selectedAt) {
      const selected = session.selectCandidates(condition, pin, selectedAt);
      return Object.freeze({
        ...selected,
        candidate_keys: Object.freeze([...selected.candidate_keys, UNBOUND_EVIDENCE_ID])
      });
    }
  };
}

