import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  SoulMemorySearchResponseSchema,
  SoulOpenPointerResponseSchema,
  formatConditionalFieldDigest
} from "@do-soul/alaya-protocol";
import {
  EventPublisher,
  RecallService,
  RelationAssertionService,
  capableRecallConsumerDeclaration,
  compileConditionalFieldQuery,
  fieldContractSha256,
  runConditionalFieldRecallWithReceipt
} from "@do-soul/alaya-core";
import {
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteGardenTaskRepo,
  SqliteRelationAssertionRepo,
  SqliteRelationRecallReader,
  SqliteSourceRootRecallReader,
  closeCachedDatabase,
  initDatabase,
  prepareIndexedRecallProjection
} from "@do-soul/alaya-storage";
import { createDaemonHostSessionCapture, MCP_HOST_SESSION_ISSUER } from "../../../garden/host-session/host-session-capture.js";
import { createProvenanceVerifiedPathCandidatePort } from "../../../runtime/garden-wiring/garden-legacy-path-admission.js";
import { materializeWorkspaceSessionStructuralRelations } from "../../../runtime/garden-wiring/session-structural-relations.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { collectSoftStructuralNeighbors } from "../../../runtime/recall-read-worker/member-index.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { CLOCK, PROVIDER_FREE_WORKER_IMPORT, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createGroundedEvent(
  eventLogRepo: SqliteEventLogRepo,
  workspaceId: string,
  entityId: string
) {
  return eventLogRepo.append({
    event_type: "engine.response.received",
    entity_type: "engine_response",
    entity_id: entityId,
    workspace_id: workspaceId,
    run_id: "run-1",
    caused_by: "test",
    payload_json: { entityId }
  });
}

it("populates intra-session and grounded garden relations and verifies bridge and erase barriers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alaya-cf-struct-capture-"));
  const filename = join(dir, "alaya.db");
  const database = initDatabase({ filename });
  prepareIndexedRecallProjection(database);
  try {
    database.connection.prepare(
      "INSERT OR IGNORE INTO workspaces (workspace_id, name, root_path, workspace_kind, created_at, workspace_state) VALUES (?, ?, '/tmp/ws', 'local', ?, 'active')"
    ).run(WS, WS, CLOCK);
    database.connection.prepare(
      "INSERT OR IGNORE INTO runs (run_id, workspace_id, title, run_mode, run_state, created_at, last_active_at) VALUES ('run-1', ?, 'Run 1', 'interactive', 'idle', ?, ?)"
    ).run(WS, CLOCK, CLOCK);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const runtimeNotifier = { notify: async () => undefined, notifyEntry: async () => undefined };
    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runtimeNotifier,
      runHotStateService: { apply: () => undefined }
    });
    const relationAssertionService = new RelationAssertionService({
      repo: new SqliteRelationAssertionRepo(database),
      eventPublisher,
      eventHistory: eventLogRepo
    });
    const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    const capture = createDaemonHostSessionCapture({
      stores,
      eventLogRepo,
      runtimeNotifier,
      gardenTaskRepo,
      relationAssertionService,
      now: () => CLOCK,
      warn: () => undefined
    });

    const captured = await capture.capture({
      workspaceId: WS,
      runId: "run-1",
      issuer: MCP_HOST_SESSION_ISSUER,
      request: {
        container: { scope: "session", id: "conv-1" },
        closes_tail: true,
        messages: [
          { message_id: "m0", position: 0, role: "user", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-10T10:00:00.000Z", content: "Alice moved to Kyoto and works at Harbor Labs." },
          { message_id: "m1", position: 1, role: "assistant", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-10T10:00:10.000Z", content: "Got it, Harbor Labs in Kyoto." },
          { message_id: "m2", position: 2, role: "user", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-11T10:00:00.000Z", content: "Her monthly studio rent budget is 1200 dollars." },
          { message_id: "m3", position: 3, role: "assistant", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-11T10:00:10.000Z", content: "Noted studio rent budget 1200 dollars." },
          { message_id: "m4", position: 4, role: "user", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-15T10:00:00.000Z", content: "Update: her monthly studio rent budget is 1450 dollars." },
          { message_id: "m5", position: 5, role: "assistant", completeness: "complete", fidelity: "original_bytes", host_reported_at: "2026-09-15T10:00:10.000Z", content: "Updated monthly studio rent budget to 1450 dollars." }
        ]
      }
    });
    expect(captured.admitted_round_count).toBe(3);

    const roundEdges = database.connection.prepare(
      "SELECT relation_kind FROM relation_assertions WHERE workspace_id = ? ORDER BY relation_kind"
    ).all(WS) as Array<{ readonly relation_kind: string }>;
    expect(roundEdges.map(row => row.relation_kind)).toEqual([
      "next_round_in_session",
      "next_round_in_session",
      "prev_round_in_session",
      "prev_round_in_session"
    ]);

    const s1 = captured.message_sources!.find(row => row.message_id === "m2")!.source;
    const s2 = captured.message_sources!.find(row => row.message_id === "m4")!.source;
    const r1 = s1.root_id;
    const r2 = s2.root_id;
    const insertCapsule = database.connection.prepare(
      `INSERT INTO evidence_capsules (object_id, lifecycle_state, created_at, updated_at, created_by, evidence_kind, semantic_anchor, event_anchor, gist, run_id, workspace_id)
       VALUES (?, 'active', ?, ?, 'test', 'explicit', 'statement', ?, ?, 'run-1', ?)`
    );
    const insertArtifact = database.connection.prepare(
      `INSERT INTO source_statement_artifacts (workspace_id, artifact_id, record_id, source_id, target_json, key_text)
       VALUES (?, ?, ?, ?, '{}', ?)`
    );
    const insertDependency = database.connection.prepare(
      `INSERT INTO source_statement_dependencies (workspace_id, artifact_id, record_id, source_id) VALUES (?, ?, ?, ?)`
    );
    const insertMemory = database.connection.prepare(
      `INSERT INTO memory_entries (object_id, lifecycle_state, created_at, updated_at, created_by, dimension, source_kind, formation_kind, scope_class, content, evidence_refs, workspace_id, run_id, valid_from)
       VALUES (?, 'active', ?, ?, 'test', 'observation', 'compiler', 'extracted', 'project', ?, ?, ?, 'run-1', ?)`
    );
    const insertBinding = database.connection.prepare(
      `INSERT INTO source_statement_memory_bindings (workspace_id, memory_id, artifact_id) VALUES (?, ?, ?)`
    );

    const ev1 = await createGroundedEvent(eventLogRepo, WS, "ev-cap-1");
    const ev2 = await createGroundedEvent(eventLogRepo, WS, "ev-cap-2");
    insertCapsule.run("cap-1", CLOCK, CLOCK, JSON.stringify({ event_type: ev1.event_type, event_id: ev1.event_id, occurred_at: "2026-09-11T10:00:00.000Z" }), "rent 1200", WS);
    insertCapsule.run("cap-2", CLOCK, CLOCK, JSON.stringify({ event_type: ev2.event_type, event_id: ev2.event_id, occurred_at: "2026-09-15T10:00:00.000Z" }), "rent 1450", WS);
    insertArtifact.run(WS, "cap-1", r1, s1.source_id, "Her monthly studio rent budget is 1200 dollars.");
    insertArtifact.run(WS, "cap-2", r2, s2.source_id, "Update: her monthly studio rent budget is 1450 dollars.");
    insertDependency.run(WS, "cap-1", r1, s1.source_id);
    insertDependency.run(WS, "cap-2", r2, s2.source_id);
    await eventLogRepo.append({
      event_type: "soul.memory.created",
      entity_type: "memory_entry",
      entity_id: "mem-1",
      workspace_id: WS,
      run_id: "run-1",
      caused_by: "test",
      payload_json: { object_id: "mem-1" }
    });
    await eventLogRepo.append({
      event_type: "soul.memory.created",
      entity_type: "memory_entry",
      entity_id: "mem-2",
      workspace_id: WS,
      run_id: "run-1",
      caused_by: "test",
      payload_json: { object_id: "mem-2" }
    });
    insertMemory.run("mem-1", CLOCK, CLOCK, "Her monthly studio rent budget is 1200 dollars.", JSON.stringify(["cap-1"]), WS, "2026-09-11T10:00:00.000Z");
    insertMemory.run("mem-2", CLOCK, CLOCK, "Update: her monthly studio rent budget is 1450 dollars.", JSON.stringify(["cap-2"]), WS, "2026-09-15T10:00:00.000Z");
    insertBinding.run(WS, "mem-1", "cap-1");
    insertBinding.run(WS, "mem-2", "cap-2");

    const materialized = await materializeWorkspaceSessionStructuralRelations({
      database,
      assertionService: relationAssertionService,
      workspaceId: WS,
      admittedAt: CLOCK
    });
    expect(materialized.assertionsAdmitted).toBeGreaterThanOrEqual(1);

    const provenancePort = createProvenanceVerifiedPathCandidatePort({
      database,
      assertionService: relationAssertionService,
      warn: () => undefined
    });
    const mintOutcome = await provenancePort.submitCandidate({
      workspaceId: WS,
      sourceAnchor: { kind: "object", object_id: "mem-2" },
      targetAnchor: { kind: "object", object_id: "mem-1" },
      relationKind: "supports",
      initialStrength: 0.7,
      governanceClass: "recall_allowed",
      evidenceBasis: ["cap-2", "cap-1"],
      recallBiasSign: 1
    });
    expect(mintOutcome).toBe("applied");

    const projections = database.connection.prepare(
      "SELECT COUNT(*) AS n FROM relation_path_projections WHERE workspace_id = ?"
    ).get(WS) as { readonly n: number };
    expect(projections.n).toBeGreaterThanOrEqual(2);

    const reader = new SqliteRelationRecallReader(database);
    const bridged = reader.read(WS, r2, "supersedes", 16);
    expect(bridged.observations).toHaveLength(1);
    expect(bridged.observations[0]!.sourceObjectId).toBe(r2);
    expect(bridged.observations[0]!.targetObjectId).toBe(r1);

    database.connection.prepare(
      `INSERT INTO projection_erase_barriers (workspace_id, barrier_id, receipt_identity, generation_id, subject_kind, subject_id, erased_at)
       VALUES (?, 'barrier-r1', 'erase-r1', NULL, 'source_record', ?, ?)`
    ).run(WS, r1, CLOCK);
    expect(reader.read(WS, r2, "supersedes", 16).observations).toHaveLength(0);
  } finally {
    database.close();
    closeCachedDatabase(filename);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("executes non-EPSILON Conditional Field structural relations through SQLite and built worker", async () => {
  const sources = [
    {
      id: "host-session:conv:r0",
      text: "User: We visited Lantern Archive for the rare atlas.",
      eventTime: "2026-09-10T10:00:00.000Z",
      vector: [1, 0, 0]
    },
    {
      id: "host-session:conv:r1",
      text: "Assistant: The third vault stays locked overnight.",
      eventTime: "2026-09-10T10:01:00.000Z",
      vector: [0, 1, 0]
    }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const r0 = fixture.targets.find(row => row.source_id === "host-session:conv:r0")!.target.root_id;
    const r1 = fixture.targets.find(row => row.source_id === "host-session:conv:r1")!.target.root_id;
    const insertMsg = database.connection.prepare(
      `INSERT INTO host_session_messages (workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id)
       VALUES (?, 'conv-key', ?, ?, 'session', 'conv', 'user', 'complete', 'original_bytes', ?, ?, 'run-cf', 'test', ?, NULL, ?, ?)`
    );
    insertMsg.run(WS, "msg-0", 0, "2026-09-10T10:00:00.000Z", sha256Hex("r0"), CLOCK, 0, r0);
    insertMsg.run(WS, "msg-1", 1, "2026-09-10T10:01:00.000Z", sha256Hex("r1"), CLOCK, 1, r1);

    const eventLogRepo = new SqliteEventLogRepo(database);
    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runtimeNotifier: { notify: async () => undefined, notifyEntry: async () => undefined },
      runHotStateService: { apply: () => undefined }
    });
    const assertionService = new RelationAssertionService({
      repo: new SqliteRelationAssertionRepo(database),
      eventPublisher,
      eventHistory: eventLogRepo
    });
    const materialized = await materializeWorkspaceSessionStructuralRelations({
      database,
      assertionService,
      workspaceId: WS,
      admittedAt: CLOCK
    });
    expect(materialized.assertionsAdmitted).toBe(2);

    const readers = createConditionalFieldObserverReaders(database);
    const recallResult = runConditionalFieldRecallWithReceipt({
      workspace_id: WS,
      query_text: "Lantern Archive",
      snapshot_id: fixture.selection.profile_id,
      interpretation_clock: CLOCK,
      as_of: CLOCK,
      expires_at: "2026-09-19T00:00:00.000Z",
      lifetime_now: CLOCK,
      authorized_scopes: ["project"],
      result_kind_view: "source_only",
      interpretation_proposal: {
        schema_version: 1,
        original_query_digest: formatConditionalFieldDigest(sha256Hex("Lantern Archive")),
        producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
        evidence_conditions: [
          { statement: "User visited <place>.", speaker: "user", anchors: ["Lantern"] }
        ]
      },
      budget: {
        schema_version: 1,
        work_units: 100_000,
        memory_bytes: 900_000,
        page_budget: 16,
        finalization_reserve: 10_000,
        min_envelope: 10
      },
      readers
    });
    const compileInput = recallResult.execution_receipt.compile_input as Parameters<typeof compileConditionalFieldQuery>[0] & {
      readonly available_relation_kinds?: readonly string[];
    };
    expect(compileInput.available_relation_kinds).toEqual(["next_round_in_session", "prev_round_in_session"]);
    const compiled = compileConditionalFieldQuery(compileInput);
    expect(compiled.program.kind).toBe("alternative");
    if (compiled.program.kind === "alternative") {
      expect(compiled.program.options[0]?.kind).toBe("epsilon");
      expect(compiled.program.options[1]?.kind).toBe("hyperedge");
    }
    const targetRootIds = recallResult.index.entries.map(entry =>
      entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id
    );
    expect(targetRootIds).toContain(r0);
    expect(targetRootIds).toContain(r1);
    const derivedEntry = recallResult.index.entries.find(entry =>
      entry.target.kind === "source_evidence" && entry.target.root_id === r1
    );
    expect(derivedEntry).toBeDefined();
    expect(derivedEntry!.association_milligrades).toBe(750);
    expect(derivedEntry!.explanation_ids.length).toBeGreaterThan(0);
    expect(recallResult.index.explanations?.some(item => item.kind === "serial")).toBe(true);
    expect(recallResult.index.explanations?.some(item => item.association_milligrades === 750)).toBe(true);
    expect(recallResult.execution_receipt.actual!.charged_retained_bytes).toBeLessThan(1_000_000);

    assertBuiltWorker();
    const guard = PROVIDER_FREE_WORKER_IMPORT;
    process.execArgv.push(guard);
    let client: ReturnType<typeof createRecallReadWorkerClient> = null;
    try {
      client = createRecallReadWorkerClient({
        databaseFilename: fixture.filename,
        workerUrl: builtWorkerUrl,
        workerCount: 1,
        prepareSourceQuery: fixture.prepareQuery
      });
    } finally {
      process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1);
    }
    expect(client).not.toBeNull();
    try {
      await client!.ready();
      const recallService = new RecallService({
        ...createDependencies().dependencies,
        now: () => CLOCK,
        readSnapshot: client!.readSnapshot,
        conditionalFieldPort: client!.conditionalFieldPort,
        activeConstraintsPort: client!.activeConstraintsPort
      });
      const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService });
      const callRecall = async () => {
        const res = await handler.call({
          toolName: "soul.recall",
          arguments: {
            ...capableRecallConsumerDeclaration(),
            query: "Lantern Archive",
            scope_class: "project",
            dimension: null,
            domain_tags: null,
            max_results: 5,
            result_kind_view: "source_only",
            query_coordinates: {
              evidence_conditions: [
                { statement: "User visited <place>.", speaker: "user", anchors: ["Lantern"] }
              ]
            }
          },
          context: { workspaceId: WS, runId: null, sessionId: "s-worker", agentTarget: "codex" }
        });
        if (!res.ok) throw new Error(JSON.stringify(res.error));
        return SoulMemorySearchResponseSchema.parse(res.output);
      };
      const first = await callRecall();
      const workerRoots = first.results.map(item =>
        item.target.kind === "source_evidence" ? item.target.root_id : item.target.object_id
      );
      expect(workerRoots).toContain(r0);
      expect(workerRoots).toContain(r1);

      database.connection.prepare(
        `INSERT INTO projection_erase_barriers (workspace_id, barrier_id, receipt_identity, generation_id, subject_kind, subject_id, erased_at)
         VALUES (?, 'barrier-r1-worker', 'erase-r1-worker', NULL, 'source_record', ?, ?)`
      ).run(WS, r1, CLOCK);
      const afterErase = await callRecall();
      const afterEraseRoots = afterErase.results.map(item =>
        item.target.kind === "source_evidence" ? item.target.root_id : item.target.object_id
      );
      expect(afterEraseRoots).toContain(r0);
      expect(afterEraseRoots).not.toContain(r1);
    } finally {
      await client?.close();
    }
  });
});

const PAST = "2020-01-01T00:00:00.000Z";
const TIGHT_BUDGET = {
  schema_version: 1 as const, work_units: 10_000, memory_bytes: 900_000,
  page_budget: 5, finalization_reserve: 100, min_envelope: 10
};

function lanternProposal(query: string) {
  return {
    schema_version: 1 as const,
    original_query_digest: formatConditionalFieldDigest(sha256Hex(query)),
    producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
    evidence_conditions: [{ statement: "User visited <place>.", speaker: "user" as const, anchors: ["Lantern"] }]
  };
}

function createAssertionService(database: ReturnType<typeof initDatabase>) {
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runtimeNotifier: { notify: async () => undefined, notifyEntry: async () => undefined },
    runHotStateService: { apply: () => undefined }
  });
  return {
    eventLogRepo,
    assertionService: new RelationAssertionService({
      repo: new SqliteRelationAssertionRepo(database), eventPublisher, eventHistory: eventLogRepo
    })
  };
}

function insertSessionRounds(
  database: ReturnType<typeof initDatabase>, r0: string, r1: string, t0: string, t1: string
) {
  const insertMsg = database.connection.prepare(
    `INSERT INTO host_session_messages (workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id)
     VALUES (?, 'conv-key', ?, ?, 'session', 'conv', 'user', 'complete', 'original_bytes', ?, ?, 'run-cf', 'test', ?, NULL, ?, ?)`
  );
  insertMsg.run(WS, "msg-0", 0, t0, sha256Hex("r0"), CLOCK, 0, r0);
  insertMsg.run(WS, "msg-1", 1, t1, sha256Hex("r1"), CLOCK, 1, r1);
}

function pageRoots(index: { entries: readonly { target: { kind: string; root_id?: string; object_id?: string } }[] }) {
  return index.entries.map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id);
}

it("hides future-admitted relation kinds from asOf and compiles EPSILON until they are visible", async () => {
  const sources = [
    { id: "host-session:conv:r0", text: "User: We visited Lantern Archive for the rare atlas.", eventTime: "2026-09-10T10:00:00.000Z", vector: [1, 0, 0] },
    { id: "host-session:conv:r1", text: "Assistant: The third vault stays locked overnight.", eventTime: "2026-09-11T10:00:00.000Z", vector: [0, 1, 0] }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const r0 = fixture.targets.find(row => row.source_id === sources[0]!.id)!.target.root_id;
    const r1 = fixture.targets.find(row => row.source_id === sources[1]!.id)!.target.root_id;
    insertSessionRounds(database, r0, r1, sources[0]!.eventTime, sources[1]!.eventTime);
    const { assertionService } = createAssertionService(database);
    await materializeWorkspaceSessionStructuralRelations({
      database, assertionService, workspaceId: WS, useSourceRecordedTime: true
    });
    const admitted = database.connection.prepare(
      "SELECT min(admitted_at) AS earliest, max(admitted_at) AS latest FROM relation_assertions WHERE workspace_id = ?"
    ).get(WS) as { readonly earliest: string; readonly latest: string };
    expect(admitted.latest <= "2026-09-11T10:00:00.000Z").toBe(true);
    const readers = createConditionalFieldObserverReaders(database);
    expect(readers.relationKinds!({ workspaceId: WS, subject: null, limit: 32, asOf: "2026-09-10T10:30:00.000Z" })).toEqual([]);
    expect(readers.relationKinds!({ workspaceId: WS, subject: null, limit: 32, asOf: CLOCK })).toEqual([
      "next_round_in_session", "prev_round_in_session"
    ]);
    const recall = (asOf: string) => runConditionalFieldRecallWithReceipt({
      workspace_id: WS, query_text: "Lantern Archive", snapshot_id: fixture.selection.profile_id,
      interpretation_clock: CLOCK, as_of: asOf, expires_at: "2026-09-19T00:00:00.000Z", lifetime_now: CLOCK,
      authorized_scopes: ["project"], result_kind_view: "source_only", interpretation_proposal: lanternProposal("Lantern Archive"),
      budget: TIGHT_BUDGET, readers
    });
    const hidden = recall("2026-09-10T10:30:00.000Z");
    const visible = recall(CLOCK);
    const hiddenKinds = (hidden.execution_receipt.compile_input as { available_relation_kinds?: readonly string[] })
      .available_relation_kinds;
    expect(hiddenKinds === undefined || hiddenKinds.length === 0).toBe(true);
    expect(compileConditionalFieldQuery(hidden.execution_receipt.compile_input as Parameters<typeof compileConditionalFieldQuery>[0]).program.kind)
      .toBe("epsilon");
    expect((visible.execution_receipt.compile_input as { available_relation_kinds?: readonly string[] }).available_relation_kinds)
      .toEqual(["next_round_in_session", "prev_round_in_session"]);
  });
});

it("does not starve mixed or source_only page-1 hydration under dense memory_entries", async () => {
  const sources = [
    { id: "host-session:conv:r0", text: "User: We visited Lantern Archive for the rare atlas.", eventTime: "2026-09-10T10:00:00.000Z", vector: [1, 0, 0] },
    { id: "host-session:conv:r1", text: "Assistant: The third vault stays locked overnight.", eventTime: "2026-09-10T10:01:00.000Z", vector: [0, 1, 0] }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const r0 = fixture.targets.find(row => row.source_id === sources[0]!.id)!.target.root_id;
    const r1 = fixture.targets.find(row => row.source_id === sources[1]!.id)!.target.root_id;
    insertSessionRounds(database, r0, r1, sources[0]!.eventTime, sources[1]!.eventTime);
    const { assertionService, eventLogRepo } = createAssertionService(database);
    await materializeWorkspaceSessionStructuralRelations({ database, assertionService, workspaceId: WS, admittedAt: CLOCK });
    const insertMemory = database.connection.prepare(
      `INSERT INTO memory_entries (object_id, lifecycle_state, created_at, updated_at, created_by, dimension, source_kind, formation_kind, scope_class, content, evidence_refs, workspace_id, run_id, valid_from)
       VALUES (?, 'active', ?, ?, 'test', 'observation', 'compiler', 'extracted', 'project', ?, '[]', ?, 'run-1', ?)`
    );
    for (let index = 0; index < 80; index += 1) {
      const objectId = `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`;
      await eventLogRepo.append({
        event_type: "soul.memory.created", entity_type: "memory_entry", entity_id: objectId,
        workspace_id: WS, run_id: "run-1", caused_by: "test", payload_json: { object_id: objectId }
      });
      insertMemory.run(objectId, CLOCK, CLOCK, `Archive note ${index} about the lantern vault.`, WS, CLOCK);
    }
    const readers = createConditionalFieldObserverReaders(database);
    const recall = (view: "mixed" | "source_only", asOf: string) => runConditionalFieldRecallWithReceipt({
      workspace_id: WS, query_text: "Lantern Archive", snapshot_id: fixture.selection.profile_id,
      interpretation_clock: CLOCK, as_of: asOf, expires_at: "2026-09-19T00:00:00.000Z", lifetime_now: CLOCK,
      authorized_scopes: ["project"], result_kind_view: view, interpretation_proposal: lanternProposal("Lantern Archive"),
      budget: TIGHT_BUDGET, readers
    });
    for (const view of ["source_only", "mixed"] as const) {
      const baseline = recall(view, PAST);
      const treated = recall(view, CLOCK);
      expect(treated.index.completeness.payload).not.toBe("omitted");
      expect(treated.index.completeness.transport).not.toBe("interrupted");
      const baselineRoots = pageRoots(baseline.index);
      const treatedRoots = pageRoots(treated.index);
      expect(treatedRoots.length).toBeGreaterThanOrEqual(baselineRoots.length);
      expect(baselineRoots.every(id => treatedRoots.includes(id))).toBe(true);
      for (const entry of treated.index.entries) {
        if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) continue;
        expect(entry.target.span.content_end - entry.target.span.content_start).toBeGreaterThan(17);
      }
    }
  });
});

it("exposes a Soft-grade non-pool graph neighbor in member_index with an openable source_target", async () => {
  const sources = [
    ...Array.from({ length: 32 }, (_, index) => ({
      id: `host-session:conv:r${index}`,
      text: `User: We visited Lantern Archive hall ${index}.`,
      eventTime: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
      vector: [1, 0, 0] as const
    })),
    {
      id: "host-session:conv:neighbor",
      text: "User: The third vault stays locked overnight.",
      eventTime: "2026-09-10T11:00:00.000Z",
      vector: [0, 1, 0] as const
    }
  ];
  await withIndexedSources(sources, async (fixture) => {
    const { database } = fixture;
    const neighbor = fixture.targets.find(row => row.source_id === "host-session:conv:neighbor")!.target.root_id;
    const insertMsg = database.connection.prepare(
      `INSERT INTO host_session_messages (workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id)
       VALUES (?, ?, ?, ?, 'session', 'conv', 'user', 'complete', 'original_bytes', ?, ?, 'run-cf', 'test', ?, NULL, ?, ?)`
    );
    for (const target of fixture.targets) {
      if (target.source_id === "host-session:conv:neighbor") continue;
      const lantern = target.target.root_id;
      insertMsg.run(WS, `conv-${lantern}`, `m0-${lantern}`, 0, "2026-09-10T10:00:00.000Z", sha256Hex(lantern), CLOCK, 0, lantern);
      insertMsg.run(WS, `conv-${lantern}`, `m1-${lantern}`, 1, "2026-09-10T11:00:00.000Z", sha256Hex(neighbor), CLOCK, 1, neighbor);
    }
    const { assertionService } = createAssertionService(database);
    const materialized = await materializeWorkspaceSessionStructuralRelations({
      database, assertionService, workspaceId: WS, admittedAt: CLOCK
    });
    expect(materialized.assertionsAdmitted).toBeGreaterThanOrEqual(2);
    const lanternRoots = fixture.targets.filter(row => row.source_id !== "host-session:conv:neighbor").map(row => row.target.root_id);
    expect(collectSoftStructuralNeighbors(database, {
      workspaceId: WS, asOf: CLOCK, anchors: lanternRoots, exclude: new Set(lanternRoots)
    }).some(source => source.target.root_id === neighbor)).toBe(true);
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK,
      recallService: new RecallService({
        ...createDependencies().dependencies, now: () => CLOCK,
        readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
        activeConstraintsPort: client.activeConstraintsPort
      })
    });
    const output = await handler.call({
      toolName: "soul.recall",
      arguments: {
        ...capableRecallConsumerDeclaration(), query: "Lantern Archive", scope_class: "project",
        dimension: null, domain_tags: null, max_results: 5, result_kind_view: "source_only",
        query_coordinates: { evidence_conditions: [{ statement: "User visited <place>.", speaker: "user", anchors: ["Lantern"] }] }
      },
      context: { workspaceId: WS, runId: null, sessionId: "s-neighbor", agentTarget: "codex" }
    });
    if (!output.ok) throw new Error(JSON.stringify(output.error));
    const recalled = SoulMemorySearchResponseSchema.parse(output.output);
    const delivered = new Set(recalled.results.map(item => item.target.kind === "source_evidence" ? item.target.root_id : ""));
    expect(delivered.has(neighbor)).toBe(false);
    const memberRoots = (recalled.member_index ?? []).map(item => item.root_id);
    const line = (recalled.member_index ?? []).find(item => item.root_id === neighbor);
    if (line === undefined) throw new Error(`neighbor=${neighbor} members=${JSON.stringify(memberRoots)}`);
    expect(line.in_pool).toBe(false);
    const sourceTarget = line.source_target;
    if (sourceTarget === undefined) throw new Error("member_index line missing source_target");
    expect(sourceTarget.root_id).toBe(neighbor);
    const poolLines = (recalled.member_index ?? []).filter(item => item.in_pool);
    const neighborIndex = (recalled.member_index ?? []).findIndex(item => item.root_id === neighbor);
    expect(neighborIndex).toBeGreaterThanOrEqual(poolLines.length);
    const opened = await createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK,
      fieldSource: new SqliteSourceRootRecallReader(
        new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
        new SqliteEvidenceCapsuleRepo(database)
      )
    }).call({
      toolName: "soul.open_pointer", arguments: { source_target: line!.source_target },
      context: { workspaceId: WS, runId: "run-1", sessionId: "s-neighbor", agentTarget: "codex" }
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const parsed = SoulOpenPointerResponseSchema.parse(opened.output);
    expect(parsed.object_kind).toBe("source_evidence");
    expect(parsed.content.content).toContain("third vault");
  });
});
