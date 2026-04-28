import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, SqliteHandoffGapRepo, SqliteWorkspaceRepo, SqliteRunRepo } from "@do-what/storage";
import { ControlPlaneObjectKind, RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-what/protocol";
import type { CandidateMemorySignal } from "@do-what/protocol";
import { SqliteHandoffGapAdapter } from "../handoff-gap-adapter.js";

// ---------------------------------------------------------------------------
// Shared test setup
// ---------------------------------------------------------------------------

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createAdapter(): {
  adapter: SqliteHandoffGapAdapter;
  repo: SqliteHandoffGapRepo;
  database: ReturnType<typeof initDatabase>;
} {
  const database = initDatabase(); // in-memory
  databases.add(database);
  seedDefaultParentRuns(database);
  const repo = new SqliteHandoffGapRepo(database);
  const adapter = new SqliteHandoffGapAdapter(repo);
  return { adapter, repo, database };
}

function seedDefaultParentRuns(database: ReturnType<typeof initDatabase>): void {
  seedParentRuns(database, "ws-test", ["run-test-001", "run-test", "run-x", "run-1", "run-2"]);
}

function seedParentRuns(
  database: ReturnType<typeof initDatabase>,
  workspaceId: string,
  runIds: readonly string[]
): void {
  const nowIso = "2026-01-01T00:00:00.000Z";
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(workspaceId, `Workspace ${workspaceId}`, `/tmp/${workspaceId}`, "local_repo", null, "active", nowIso, null);

  const insertRun = database.connection.prepare(
    `INSERT OR IGNORE INTO runs (
      run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const runId of runIds) {
    insertRun.run(runId, workspaceId, `Run ${runId}`, null, "chat", null, "idle", null, nowIso, nowIso);
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "sig-test-001",
    workspace_id: "ws-test",
    run_id: "run-test-001",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_handoff",
    signal_state: "emitted",
    object_kind: "handoff",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeGapSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return makeSignal({
    object_kind: "gap_record",
    raw_payload: {},
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// SqliteHandoffGapAdapter — createFromSignal
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapAdapter — createFromSignal", () => {
  it("creates a handoff_record for a non-gap signal", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeSignal({ object_kind: "handoff" });

    const result = adapter.createFromSignal(signal);

    expect(result.object_kind).toBe("handoff_record");
    expect(typeof result.object_id).toBe("string");
    expect(result.object_id.length).toBeGreaterThan(0);

    // verify persisted
    const found = repo.findHandoffById(result.object_id);
    expect(found).not.toBeNull();
    expect(found?.object_kind).toBe(ControlPlaneObjectKind.HANDOFF_RECORD);
    expect(found?.source_run_id).toBe("run-test-001");
  });

  it("creates a gap_record when object_kind is gap_record", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeGapSignal({ object_kind: "gap_record" });

    const result = adapter.createFromSignal(signal);

    expect(result.object_kind).toBe("gap_record");

    const found = repo.findGapById(result.object_id);
    expect(found).not.toBeNull();
    expect(found?.object_kind).toBe(ControlPlaneObjectKind.GAP_RECORD);
  });

  it("creates a gap_record when raw_payload.gap_detected is true", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeSignal({
      object_kind: "potential_claim",
      raw_payload: { gap_detected: true }
    });

    const result = adapter.createFromSignal(signal);

    expect(result.object_kind).toBe("gap_record");

    const found = repo.findGapById(result.object_id);
    expect(found).not.toBeNull();
  });

  it("creates a gap_record for object_kind 'gap'", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeSignal({ object_kind: "gap" });

    const result = adapter.createFromSignal(signal);
    expect(result.object_kind).toBe("gap_record");
    expect(repo.findGapById(result.object_id)).not.toBeNull();
  });

  it("creates a gap_record for object_kind 'context_gap'", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeSignal({ object_kind: "context_gap" });

    const result = adapter.createFromSignal(signal);
    expect(result.object_kind).toBe("gap_record");
  });

  it("sets gap description from raw_payload.excerpt when present", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeGapSignal({ raw_payload: { excerpt: "Context lost here" } });

    const result = adapter.createFromSignal(signal);
    const found = repo.findGapById(result.object_id);
    expect(found?.description).toBe("Context lost here");
  });

  it("falls back to raw_payload.matched_text for description", () => {
    const { adapter, repo } = createAdapter();
    const signal = makeGapSignal({ raw_payload: { matched_text: "some matched text" } });

    const result = adapter.createFromSignal(signal);
    const found = repo.findGapById(result.object_id);
    expect(found?.description).toContain("some matched text");
  });
});

// ---------------------------------------------------------------------------
// SqliteHandoffGapAdapter — listHandoffs
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapAdapter — listHandoffs", () => {
  it("returns both handoffs and gaps via listHandoffs()", () => {
    const { adapter } = createAdapter();

    adapter.createFromSignal(makeSignal({ object_kind: "handoff", signal_id: "sig-1" }));
    adapter.createFromSignal(makeGapSignal({ signal_id: "sig-2" }));

    const all = adapter.listHandoffs();
    expect(all).toHaveLength(2);

    const kinds = all.map((r) => r.object_kind);
    expect(kinds).toContain(ControlPlaneObjectKind.HANDOFF_RECORD);
    expect(kinds).toContain(ControlPlaneObjectKind.GAP_RECORD);
  });

  it("returns empty array when nothing has been created", () => {
    const { adapter } = createAdapter();
    expect(adapter.listHandoffs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SqliteHandoffGapAdapter — clearExpired
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapAdapter — clearExpired", () => {
  it("clearExpired removes records with expires_at <= nowIso", () => {
    const { adapter, repo } = createAdapter();

    // Create a record — adapter sets expires_at in future by default
    // We'll instead directly seed the repo with an expired record
    const result = adapter.createFromSignal(makeSignal({ object_kind: "handoff" }));

    // Advance time past the record's expiry by passing a far-future nowIso
    adapter.clearExpired("2099-12-31T23:59:59.000Z");

    // Record should be gone
    expect(repo.findHandoffById(result.object_id)).toBeNull();
  });

  it("clearExpired without argument uses current time", () => {
    const { adapter } = createAdapter();

    // Should not throw even with no argument
    expect(() => adapter.clearExpired()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persistence across "daemon restart" (re-create repo on same DB)
// ---------------------------------------------------------------------------

describe("HandoffGap persistence — survives repo re-creation", () => {
  it("handoff record created via adapter is readable after creating new repo on same DB", () => {
    const database = initDatabase();
    databases.add(database);
    seedDefaultParentRuns(database);

    const repo1 = new SqliteHandoffGapRepo(database);
    const adapter1 = new SqliteHandoffGapAdapter(repo1);

    const result = adapter1.createFromSignal(makeSignal({ object_kind: "handoff" }));

    // Simulate restart: create a fresh repo on the same DB connection
    const repo2 = new SqliteHandoffGapRepo(database);

    const found = repo2.findHandoffById(result.object_id);
    expect(found).not.toBeNull();
    expect(found?.source_run_id).toBe("run-test-001");
  });

  it("gap record created via adapter is readable after creating new repo on same DB", () => {
    const database = initDatabase();
    databases.add(database);
    seedDefaultParentRuns(database);

    const repo1 = new SqliteHandoffGapRepo(database);
    const adapter1 = new SqliteHandoffGapAdapter(repo1);

    const result = adapter1.createFromSignal(makeGapSignal());

    const repo2 = new SqliteHandoffGapRepo(database);
    const found = repo2.findGapById(result.object_id);
    expect(found).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HandoffGapCleanupPort (Janitor integration)
// ---------------------------------------------------------------------------

describe("HandoffGapCleanupPort — Janitor integration", () => {
  it("findExpiredObjects returns expired records with correct shape", async () => {
    const { repo } = createAdapter();

    // Seed an expired handoff directly into repo
    const now = new Date().toISOString();
    const pastDate = "2020-01-01T00:00:00.000Z";

    const expiredId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    repo.createHandoff({
      runtime_id: expiredId,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: pastDate,
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-test",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    // Import the cleanup port factory from the adapter module
    const { buildHandoffGapCleanupPort } = await import("../handoff-gap-adapter.js");
    const cleanupPort = buildHandoffGapCleanupPort(repo);

    const expired = await cleanupPort.findExpiredObjects(now);

    expect(expired.length).toBeGreaterThanOrEqual(1);
    const entry = expired.find((e) => e.object_id === expiredId);
    expect(entry).toBeDefined();
    expect(entry?.object_kind).toBe(ControlPlaneObjectKind.HANDOFF_RECORD);
    expect(entry?.expires_at).toBe(pastDate);
  });

  it("removeExpiredObjects deletes by id from both tables", async () => {
    const { repo } = createAdapter();

    const toRemoveId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    repo.createHandoff({
      runtime_id: toRemoveId,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-x",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    const { buildHandoffGapCleanupPort } = await import("../handoff-gap-adapter.js");
    const cleanupPort = buildHandoffGapCleanupPort(repo);

    await cleanupPort.removeExpiredObjects([
      {
        object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
        object_id: toRemoveId,
        expires_at: "2020-01-01T00:00:00.000Z"
      }
    ]);

    expect(repo.findHandoffById(toRemoveId)).toBeNull();
  });

  it("non-expired records survive Janitor cleanup", async () => {
    const database = initDatabase();
    databases.add(database);
    seedDefaultParentRuns(database);
    const repo = new SqliteHandoffGapRepo(database);

    const expiredId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const liveId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    // Expired record
    repo.createHandoff({
      runtime_id: expiredId,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: "2020-01-01T00:00:00.000Z",
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-1",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });
    // Non-expired record
    repo.createHandoff({
      runtime_id: liveId,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-2",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    const { buildHandoffGapCleanupPort } = await import("../handoff-gap-adapter.js");
    const cleanupPort = buildHandoffGapCleanupPort(repo);

    const now = "2026-01-01T00:00:00.000Z";
    const expired = await cleanupPort.findExpiredObjects(now);

    // Only remove expired ones
    await cleanupPort.removeExpiredObjects(expired);

    expect(repo.findHandoffById(expiredId)).toBeNull();
    expect(repo.findHandoffById(liveId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InMemoryHandoffGapHandler must not be used in daemon
// ---------------------------------------------------------------------------

describe("P0-3b — daemon no longer uses InMemoryHandoffGapHandler", () => {
  it("handoff-gap-adapter.ts does not import InMemoryHandoffGapHandler", async () => {
    // Dynamic import to get the module source check via the module itself
    // We verify the adapter exports do NOT include InMemoryHandoffGapHandler
    const adapterModule = await import("../handoff-gap-adapter.js");
    expect((adapterModule as Record<string, unknown>)["InMemoryHandoffGapHandler"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workspace-scoped cleanup — findExpiredObjectsByWorkspace
// ---------------------------------------------------------------------------

function createWorkspaceScopedContext(): {
  repo: SqliteHandoffGapRepo;
  workspaceRepo: SqliteWorkspaceRepo;
  runRepo: SqliteRunRepo;
  database: ReturnType<typeof initDatabase>;
} {
  const database = initDatabase();
  databases.add(database);
  return {
    repo: new SqliteHandoffGapRepo(database),
    workspaceRepo: new SqliteWorkspaceRepo(database),
    runRepo: new SqliteRunRepo(database),
    database
  };
}

async function seedWorkspaceAndRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo,
  workspaceId: string,
  runId: string
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: workspaceId,
    name: `Workspace ${workspaceId}`,
    root_path: `/tmp/${workspaceId}`,
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    workspace_state: WorkspaceState.ACTIVE,
    default_engine_binding: null
  });
  await runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: `Run ${runId}`,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

describe("findExpiredObjectsByWorkspace — workspace isolation", () => {
  it("returns only expired records belonging to the specified workspace", async () => {
    const { repo, workspaceRepo, runRepo } = createWorkspaceScopedContext();

    await seedWorkspaceAndRun(workspaceRepo, runRepo, "ws-A", "run-A");
    await seedWorkspaceAndRun(workspaceRepo, runRepo, "ws-B", "run-B");

    const expiredDate = "2020-01-01T00:00:00.000Z";
    const idA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // Expired handoff in workspace A
    repo.createHandoff({
      runtime_id: idA,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: expiredDate,
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-A",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    // Expired gap in workspace B
    repo.createGap({
      runtime_id: idB,
      object_kind: ControlPlaneObjectKind.GAP_RECORD,
      task_surface_ref: null,
      expires_at: expiredDate,
      derived_from: null,
      retention_policy: "run_scoped",
      gap_kind: "context_gap",
      detected_in_run_id: "run-B",
      surface_id: null,
      description: "test gap",
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    const nowIso = "2026-01-01T00:00:00.000Z";

    // Query scoped to workspace A — should only return the handoff
    const wsAResults = repo.findExpiredObjectsByWorkspace("ws-A", nowIso);
    expect(wsAResults).toHaveLength(1);
    expect(wsAResults[0]?.object_id).toBe(idA);

    // Query scoped to workspace B — should only return the gap
    const wsBResults = repo.findExpiredObjectsByWorkspace("ws-B", nowIso);
    expect(wsBResults).toHaveLength(1);
    expect(wsBResults[0]?.object_id).toBe(idB);
  });

  it("returns empty array when workspace has no expired records", async () => {
    const { repo, workspaceRepo, runRepo } = createWorkspaceScopedContext();

    await seedWorkspaceAndRun(workspaceRepo, runRepo, "ws-empty", "run-empty");

    const results = repo.findExpiredObjectsByWorkspace("ws-empty", "2026-01-01T00:00:00.000Z");
    expect(results).toHaveLength(0);
  });

  it("does not return non-expired records even for the correct workspace", async () => {
    const { repo, workspaceRepo, runRepo } = createWorkspaceScopedContext();

    await seedWorkspaceAndRun(workspaceRepo, runRepo, "ws-live", "run-live");

    const liveId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    repo.createHandoff({
      runtime_id: liveId,
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      derived_from: null,
      retention_policy: "run_scoped",
      handoff_kind: "run_handoff",
      source_run_id: "run-live",
      target_run_id: null,
      surface_id: null,
      ttl_ms: null,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });

    const results = repo.findExpiredObjectsByWorkspace("ws-live", "2026-01-01T00:00:00.000Z");
    expect(results).toHaveLength(0);
  });
});
