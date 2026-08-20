import { afterEach, describe, expect, it } from "vitest";
import {
  RunMode,
  RunState,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";

import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import {
  SqliteRecallRoutingKeyProjectionRepo
} from "../../../repos/signal/recall-routing-key-projection-repo.js";
import { SqliteSignalRepo } from "../../../repos/signal/signal-repo.js";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("SqliteRecallRoutingKeyProjectionRepo", () => {
  it("rebuilds attributed routing projections from materialization receipts", async () => {
    const database = await createDatabase();
    const signal = createSignal();
    const signalRepo = new SqliteSignalRepo(database);
    await signalRepo.create(signal);
    await signalRepo.updateState(signal.signal_id, "materialized");
    insertMaterialization(database, signal, "memory_entry", "memory-1");

    const repo = new SqliteRecallRoutingKeyProjectionRepo(database);
    const projections = await repo.findByOwnerIds("workspace-1", ["memory-1", "missing"]);

    expect(projections).toEqual([{
      owner_id: "memory-1",
      owner_kind: "memory_entry",
      source_signal_id: "signal-1",
      independence_group: "source-event:source-event-1",
      signal_kind: "potential_preference",
      object_type: "preference",
      reliability: 0.82,
      proposed_entities: ["Bandung", "Cihampelas Walk"],
      proposed_preference: {
        subject: "user",
        predicate: "likes",
        object: "nasi goreng",
        category: "food",
        polarity: "positive"
      },
      temporal: {
        start: "2026-03-18T00:00:00.000Z",
        end: "2026-03-18T01:00:00.000Z",
        precision: "hour"
      },
      proposed_fact: "The user liked the nasi goreng at Cihampelas Walk.",
      source_version: "signal:signal-1:2026-03-18T02:00:00.000Z"
    }]);
    database.connection.prepare(`
      UPDATE signals
      SET source_observation_json = NULL, evidence_refs_json = ?
      WHERE signal_id = ?
    `).run(JSON.stringify(["evidence-1"]), signal.signal_id);
    const evidenceGrouped = await repo.findByOwnerIds("workspace-1", ["memory-1"]);
    expect(evidenceGrouped[0]?.independence_group).toBe("evidence:evidence-1");
    await expect(repo.findByOwnerIds("other-workspace", ["memory-1"]))
      .resolves.toEqual([]);
  });
});

async function createDatabase(): Promise<StorageDatabase> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "routing key run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return database;
}

function createSignal(): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_preference",
    signal_state: "materialized",
    object_kind: "preference",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.82,
    evidence_refs: [],
    canonical_entities: null,
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      source_grounding: {
        proposed_canonical_entities: ["Bandung", "Cihampelas Walk"],
        proposed_preference_profile: {
          preference_subject: "user",
          preference_predicate: "likes",
          preference_object: "nasi goreng",
          preference_category: "food",
          preference_polarity: "positive"
        },
        proposed_distilled_fact: "The user liked the nasi goreng at Cihampelas Walk."
      },
      temporal_projection: {
        event_time_start: "2026-03-18T00:00:00.000Z",
        event_time_end: "2026-03-18T01:00:00.000Z",
        time_precision: "hour"
      }
    },
    source_observation: {
      observed_at: "2026-03-18T02:00:00.000Z",
      authority: "trusted_host_event",
      source_event_id: "source-event-1"
    },
    created_at: "2026-03-18T02:00:00.000Z"
  };
}

function insertMaterialization(
  database: StorageDatabase,
  signal: CandidateMemorySignal,
  objectKind: string,
  objectId: string
): void {
  const payload = SoulSignalMaterializedPayloadSchema.parse({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    created_objects: [{ object_kind: objectKind, object_id: objectId }],
    success: true
  });
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id,
      run_id, caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, 'candidate_memory_signal', ?, ?, ?,
      'materialization_router', 0, ?, ?)
  `).run(
    "materialized-1",
    SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    signal.signal_id,
    signal.workspace_id,
    signal.run_id,
    JSON.stringify(payload),
    signal.created_at
  );
}
