import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
  type EvidenceCapsule,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, RelationAssertionService, stableStringify } from "@do-soul/alaya-core";
import { compileRecallQueryProbes } from "../../../../../../packages/core/src/recall/query/recall-query-probes.js";
import { loadActiveConstraints } from "../../../../../../packages/core/src/recall/runtime/orchestration.js";
import { collectGovernancePathDerivations } from "../../../../../../packages/core/src/recall/supplements/supplementary-data-governance-paths.js";
import { computeIntegratedFloodScore } from "../../../../../../packages/core/src/recall/scoring/integrated-flood-scoring.js";
import { computeFloodEdgeTransfer } from "../../../../../../packages/core/src/recall/flood/edge-transfer.js";
import {
  resolveConformantFloodCapPerSource,
  resolveConformantFloodCapTotal,
  resolveConformantRhoPath
} from "../../../../../../packages/core/src/recall/scoring/conformant-fusion-scoring.js";
import type { RecallSupplementaryData } from "../../../../../../packages/core/src/recall/runtime/recall-service-types.js";
import {
  StorageDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  digestRelationFormationEventSource,
  initDatabase,
  isTemporalProjectionSelected
} from "@do-soul/alaya-storage";
import { createRecallActiveConstraintsPort } from "../../../runtime/recall-materialization/recall-materialization-recall-runtime.js";
import {
  createBoundRecallPathReadPorts,
  resolveRecallPathReadBind
} from "../../../runtime/recall/recall-path-read-bind.js";

const WORKSPACE_ID = "lme-ea9098706deafa04dc8006f7520a5be854f4ef2e4ca143524caa3a7087105ea2";
const RUN_ID = "run-path-bind-fixture";
const SOURCE_ID = "91819ae1-3bfb-4bc6-921c-0a4f2f6a493c";
const TARGET_ID = "c430e48a-3d08-4893-9b50-cf1b06049f97";
const PATH_ID = "relation_assertion_0003fe6d0f2d78f4e1ef18ba0cf0b16e0c5472de62a5999d";
const EVIDENCE_ID = "32e2c58c-2f37-40cd-be8a-d12673fa7fe7";
const SHA256_FIXTURE = "a".repeat(64);

const openDatabases: StorageDatabase[] = [];
let fixtureScratch: string | null = null;
let fixtureDatabasePath: string | null = null;

beforeAll(async () => {
  fixtureScratch = mkdtempSync(path.join(tmpdir(), "alaya-path-bind-"));
  fixtureDatabasePath = path.join(fixtureScratch, "fixture.sqlite");
  const database = initDatabase({ filename: fixtureDatabasePath, temporalMode: "candidate" });
  await seedTemporalPathFixture(database);
  database.close();
});

afterEach(() => {
  for (const database of openDatabases) {
    if (!database.isClosed()) database.close();
  }
  openDatabases.length = 0;
});

afterAll(() => {
  if (fixtureScratch !== null) {
    rmSync(fixtureScratch, { recursive: true, force: true });
  }
});

describe("typed path transfer bind seam", () => {
  it("defaults to the temporal projection and returns the prepared edge", async () => {
    const database = openFixtureReadonly();
    expect(isTemporalProjectionSelected(database)).toBe(false);
    expect(countRows(database, "path_relations")).toBe(0);
    expect(countActivePathProjections(database)).toBeGreaterThan(0);
    expect(resolveRecallPathReadBind({ database })).toBe("temporal");

    const derivations = await collectLocatorDerivations(database);
    const inflow = derivations.pathInflowByTarget[TARGET_ID] ?? [];
    expect(derivations.pathInflowAvailability).toBe("available");
    expect(inflow).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathId: PATH_ID, seedObjectId: SOURCE_ID, targetObjectId: TARGET_ID })
    ]));

    const flood = computeIntegratedFloodScore({
      entry: memory(TARGET_ID),
      // This assertion isolates status mapping from edge-transfer arithmetic.
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(flood.diagnostics.path_status).toBe("active");
  });

  it("attributes a production transfer receipt without injecting A_path", async () => {
    const database = openFixtureReadonly();
    const derivations = await collectLocatorDerivations(database);
    const inflow = derivations.pathInflowByTarget[TARGET_ID] ?? [];
    expect(inflow.length).toBeGreaterThan(0);

    const transfer = computeFloodEdgeTransfer({
      inflow,
      targetObjectId: TARGET_ID,
      rObjectById: new Map([[SOURCE_ID, 1], [TARGET_ID, 1]]),
      capPerSource: resolveConformantFloodCapPerSource(),
      capTotal: resolveConformantFloodCapTotal(),
      rhoPath: resolveConformantRhoPath()
    });
    expect(transfer.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path_id: PATH_ID,
        relation_kind: "answers_with",
        seed_object_id: SOURCE_ID,
        target_object_id: TARGET_ID,
        decision: "transferred",
        edge_conductance: expect.closeTo(0.75)
      })
    ]));
    expect(transfer.value).toBeCloseTo(0.75);

    const flood = computeIntegratedFloodScore({
      entry: memory(TARGET_ID),
      axisInputs: { R_obj: 0.2, A_path: transfer.value, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(flood.diagnostics.path_status).toBe("active");
    expect(flood.diagnostics.A_path).toBeCloseTo(0.75);
  });

  it("keeps the explicit production bind on temporal authority", () => {
    const database = openFixtureReadonly();
    expect(resolveRecallPathReadBind({
      database,
      pathReadBind: "temporal"
    })).toBe("temporal");
  });

  it("seals a historical as-of miss instead of aborting recall", async () => {
    const database = openFixtureReadonly();
    const historicalAsOf = "2023-05-30T23:40:00.000Z";
    const ports = createBoundRecallPathReadPorts({ database });
    const candidates = [memory(SOURCE_ID), memory(TARGET_ID)];
    const derivations = await collectGovernancePathDerivations({
      dependencies: { pathExpansionPort: ports.pathExpansionPort },
      warn: () => undefined,
      workspaceId: WORKSPACE_ID,
      pathProjectionAsOf: historicalAsOf,
      candidates
    });
    const flood = computeIntegratedFloodScore({
      entry: candidates[1]!,
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });

    expect(derivations.pathInflowAvailability).toBe("unavailable");
    expect(flood.diagnostics.path_status).toBe("inactive:index_unavailable");
    expect(flood.diagnostics.A_path).not.toBe(1);

    const warn = vi.fn();
    const constraints = await loadActiveConstraints({
      workspaceId: WORKSPACE_ID,
      cap: null,
      asOf: historicalAsOf,
      warn,
      activeConstraintsPort: createRecallActiveConstraintsPort({
        memoryEntryRepo: { findByIds: vi.fn(async () => []) },
        claimFormRepo: { findByStatus: vi.fn(async () => []) }
      }, ports)
    });
    expect(constraints).toEqual({ constraints: [], total_count: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "active constraints lookup skipped",
      expect.objectContaining({
        workspace_id: WORKSPACE_ID,
        operation: "active_constraints",
        errorName: "TemporalProjectionGenerationMissingError"
      })
    );
    await expect(ports.findActiveByWorkspace(WORKSPACE_ID, { asOf: historicalAsOf }))
      .rejects.toMatchObject({ name: "TemporalProjectionGenerationMissingError" });
  });
});

describe("refresh-required path index", () => {
  it("seals instead of empty-legacy pass-through when a ready projection needs refresh", async () => {
    const database = initDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET projection_refresh_required = 1, projection_count = 1
      WHERE state_id = 1
    `).run();
    expect(resolveRecallPathReadBind({ database })).toBe("temporal");

    const ports = createBoundRecallPathReadPorts({ database });
    const candidates = [memory(SOURCE_ID), memory(TARGET_ID)];
    const derivations = await collectGovernancePathDerivations({
      dependencies: { pathExpansionPort: ports.pathExpansionPort },
      warn: () => undefined,
      workspaceId: WORKSPACE_ID,
      candidates
    });
    const flood = computeIntegratedFloodScore({
      entry: candidates[1]!,
      // This assertion isolates status mapping from edge-transfer arithmetic.
      axisInputs: { R_obj: 0.2, A_path: 0.5, B_evidence: 0 },
      supplementaryData: supplementary({
        pathInflowByTarget: derivations.pathInflowByTarget,
        pathInflowAvailability: derivations.pathInflowAvailability
      })
    });
    expect(derivations.pathInflowAvailability).toBe("storage_error");
    expect(flood.diagnostics.path_status).toBe("inactive:storage_error");
    expect(flood.diagnostics.A_path).not.toBe(1);
  });

  it("fails closed when a ready state points at a missing active generation", async () => {
    const database = initDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    database.connection.prepare(`
      UPDATE temporal_schema_state
      SET active_projection_generation = 'missing-generation'
      WHERE state_id = 1
    `).run();

    const ports = createBoundRecallPathReadPorts({ database });
    await expect(ports.findActiveByWorkspace(WORKSPACE_ID)).rejects.toThrow(
      "active generation is missing or inconsistent"
    );
  });
});

async function collectLocatorDerivations(database: StorageDatabase) {
  const ports = createBoundRecallPathReadPorts({ database });
  return await collectGovernancePathDerivations({
    dependencies: { pathExpansionPort: ports.pathExpansionPort },
    warn: () => undefined,
    workspaceId: WORKSPACE_ID,
    candidates: [memory(SOURCE_ID), memory(TARGET_ID)]
  });
}

function openFixtureReadonly(): StorageDatabase {
  if (fixtureDatabasePath === null) {
    throw new Error("temporal path fixture was not prepared");
  }
  const connection = new BetterSqlite3(fixtureDatabasePath, { readonly: true, fileMustExist: true });
  connection.pragma("query_only = ON");
  const database = new StorageDatabase(fixtureDatabasePath, connection);
  openDatabases.push(database);
  return database;
}

async function seedTemporalPathFixture(database: StorageDatabase): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "path bind fixture",
    root_path: "/fixture",
    workspace_kind: "local_repo",
    repo_path: "/fixture",
    default_engine_binding: null,
    workspace_state: "active"
  });
  await new SqliteRunRepo(database).create({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    title: "path bind fixture",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const sourceEvent = await appendSourceEvent(eventLogRepo);
  await new SqliteEvidenceCapsuleRepo(database).create(evidenceCapsule(sourceEvent));
  const service = new RelationAssertionService({
    repo: new SqliteRelationAssertionRepo(database),
    eventPublisher: new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: async () => undefined },
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
    }),
    eventHistory: eventLogRepo,
    now: () => sourceEvent.created_at
  });
  await service.admit(admissionRequest(sourceEvent));
}

async function appendSourceEvent(eventLogRepo: SqliteEventLogRepo): Promise<EventLogEntry> {
  return await eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    entity_type: "candidate_memory_signal",
    entity_id: "path-bind-source-signal",
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    caused_by: "path-bind-test",
    payload_json: { source: "test" }
  });
}

function evidenceCapsule(sourceEvent: Readonly<EventLogEntry>): EvidenceCapsule {
  return {
    object_id: EVIDENCE_ID,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: sourceEvent.created_at,
    updated_at: sourceEvent.created_at,
    created_by: "path-bind-test",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "typed path bind",
      keywords: ["typed", "path"],
      summary: "truth-backed path fixture"
    },
    event_anchor: {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      event_id: sourceEvent.event_id,
      occurred_at: sourceEvent.created_at
    },
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "truth-backed path fixture",
    excerpt: "The source answers with the target.",
    source_hash: null,
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    surface_id: null
  };
}

function admissionRequest(sourceEvent: Readonly<EventLogEntry>) {
  const parameters = { relation_kind: "answers_with" };
  const decision = { evidence_id: EVIDENCE_ID, source_event_id: sourceEvent.event_id };
  return {
    assertionId: PATH_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    causedBy: "path-bind-test",
    evidenceReceipts: [{
      evidence_id: EVIDENCE_ID,
      source_event_anchor: {
        event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
        event_id: sourceEvent.event_id,
        occurred_at: sourceEvent.created_at
      }
    }],
    formationReceipt: {
      operator_id: "path_bind_fixture_v1",
      operator_sha256: SHA256_FIXTURE,
      parameters,
      parameter_sha256: digest(parameters),
      source_observations: [{
        source_kind: "event_log_entry" as const,
        source_id: sourceEvent.event_id,
        source_sha256: digestRelationFormationEventSource(sourceEvent)
      }],
      decision,
      decision_sha256: digest(decision)
    },
    anchors: {
      source_anchor: { kind: "object" as const, object_id: SOURCE_ID },
      target_anchor: { kind: "object" as const, object_id: TARGET_ID }
    },
    relationKind: "answers_with",
    validity: { kind: "open" as const, valid_from: "2023-05-29T18:01:00.000Z" },
    admittedAt: sourceEvent.created_at
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function countRows(database: StorageDatabase, table: string): number {
  const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function countActivePathProjections(database: StorageDatabase): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS n
    FROM relation_path_projections
    WHERE generation = (
      SELECT active_projection_generation
      FROM temporal_schema_state
      WHERE state_id = 1 AND status = 'ready' AND projection_refresh_required = 0
    )
  `).get() as { n: number };
  return row.n;
}

function memory(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
    created_by: "bind-seam-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "typed path bind seam locator",
    domain_tags: [],
    evidence_refs: [],
    facet_tags: null,
    canonical_entities: null,
    projection_schema_version: 1,
    workspace_id: WORKSPACE_ID,
    run_id: "run-bind-seam",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function supplementary(overrides: Partial<RecallSupplementaryData> = {}): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("typed path bind seam"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}
