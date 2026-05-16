import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneObjectKind, RetentionPolicy } from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteHandoffGapRepo } from "../repos/handoff-gap-repo.js";
import type { HandoffRecord, GapRecord } from "@do-soul/alaya-protocol";

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

function createRepo(): { repo: SqliteHandoffGapRepo; database: ReturnType<typeof initDatabase> } {
  const database = initDatabase(); // in-memory
  databases.add(database);
  seedParentRuns(database, ["run-source-1", "run-source-2", "run-A", "run-B"]);
  const repo = new SqliteHandoffGapRepo(database);
  return { repo, database };
}

function seedParentRuns(database: ReturnType<typeof initDatabase>, runIds: readonly string[]): void {
  const nowIso = "2026-01-01T00:00:00.000Z";
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run("ws-handoff-gap-test", "Handoff Gap Test", "/tmp/handoff-gap-test", "local_repo", null, "active", nowIso, null);

  const insertRun = database.connection.prepare(
    `INSERT OR IGNORE INTO runs (
      run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const runId of runIds) {
    insertRun.run(runId, "ws-handoff-gap-test", `Run ${runId}`, null, "chat", null, "idle", null, nowIso, nowIso);
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeHandoffRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
    task_surface_ref: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.RUN_SCOPED,
    handoff_kind: "session_end",
    source_run_id: "run-source-1",
    target_run_id: null,
    surface_id: null,
    ttl_ms: null,
    ...overrides
  };
}

function makeGapRecord(overrides: Partial<GapRecord> = {}): GapRecord {
  return {
    runtime_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    object_kind: ControlPlaneObjectKind.GAP_RECORD,
    task_surface_ref: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.RUN_SCOPED,
    gap_kind: "context_lost",
    detected_in_run_id: "run-source-1",
    surface_id: null,
    description: "Context was lost between sessions.",
    ttl_ms: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — migration", () => {
  it("creates handoff_records table on first use", () => {
    const { database } = createRepo();

    const row = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_records'")
      .get() as { readonly name: string } | undefined;

    expect(row?.name).toBe("handoff_records");
  });

  it("creates gap_records table on first use", () => {
    const { database } = createRepo();

    const row = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gap_records'")
      .get() as { readonly name: string } | undefined;

    expect(row?.name).toBe("gap_records");
  });

  it("migration is idempotent — creating repo twice on same db does not throw", () => {
    const database = initDatabase();
    databases.add(database);

    expect(() => {
      new SqliteHandoffGapRepo(database);
      new SqliteHandoffGapRepo(database);
    }).not.toThrow();
  });

  it("creates expected indexes on handoff_records", () => {
    const { database } = createRepo();

    const indexes = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='handoff_records'")
      .all() as Array<{ readonly name: string }>;

    const names = indexes.map((r) => r.name);
    expect(names.some((n) => n.includes("source_run"))).toBe(true);
    expect(names.some((n) => n.includes("expires"))).toBe(true);
  });

  it("creates expected indexes on gap_records", () => {
    const { database } = createRepo();

    const indexes = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='gap_records'")
      .all() as Array<{ readonly name: string }>;

    const names = indexes.map((r) => r.name);
    expect(names.some((n) => n.includes("detected") || n.includes("run"))).toBe(true);
    expect(names.some((n) => n.includes("expires"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HandoffRecord CRUD
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — HandoffRecord CRUD", () => {
  it("createHandoff + findHandoffById roundtrip", () => {
    const { repo } = createRepo();
    const record = makeHandoffRecord();

    repo.createHandoff(record);
    const found = repo.findHandoffById(record.runtime_id);

    expect(found).not.toBeNull();
    expect(found?.runtime_id).toBe(record.runtime_id);
    expect(found?.handoff_kind).toBe("session_end");
    expect(found?.source_run_id).toBe("run-source-1");
    expect(found?.object_kind).toBe(ControlPlaneObjectKind.HANDOFF_RECORD);
  });

  it("findHandoffById returns null for unknown id", () => {
    const { repo } = createRepo();
    expect(repo.findHandoffById("nonexistent-id")).toBeNull();
  });

  it("findGapById returns null for a handoff id (wrong table)", () => {
    const { repo } = createRepo();
    const record = makeHandoffRecord();
    repo.createHandoff(record);

    expect(repo.findGapById(record.runtime_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GapRecord CRUD
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — GapRecord CRUD", () => {
  it("createGap + findGapById roundtrip", () => {
    const { repo } = createRepo();
    const record = makeGapRecord();

    repo.createGap(record);
    const found = repo.findGapById(record.runtime_id);

    expect(found).not.toBeNull();
    expect(found?.runtime_id).toBe(record.runtime_id);
    expect(found?.gap_kind).toBe("context_lost");
    expect(found?.description).toBe("Context was lost between sessions.");
    expect(found?.object_kind).toBe(ControlPlaneObjectKind.GAP_RECORD);
  });

  it("findGapById returns null for unknown id", () => {
    const { repo } = createRepo();
    expect(repo.findGapById("nonexistent-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listAll + findByRunId
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — listAll and findByRunId", () => {
  it("listAll returns records from both tables", () => {
    const { repo } = createRepo();
    repo.createHandoff(makeHandoffRecord({ runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    repo.createGap(makeGapRecord({ runtime_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));

    const all = repo.listAll();
    expect(all).toHaveLength(2);

    const kinds = all.map((r) => r.object_kind);
    expect(kinds).toContain(ControlPlaneObjectKind.HANDOFF_RECORD);
    expect(kinds).toContain(ControlPlaneObjectKind.GAP_RECORD);
  });

  it("findByRunId returns only records matching that run", () => {
    const { repo } = createRepo();

    repo.createHandoff(makeHandoffRecord({
      runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source_run_id: "run-A"
    }));
    repo.createHandoff(makeHandoffRecord({
      runtime_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      source_run_id: "run-B"
    }));
    repo.createGap(makeGapRecord({
      runtime_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      detected_in_run_id: "run-A"
    }));

    const runA = repo.findByRunId("run-A");
    expect(runA).toHaveLength(2);
    for (const r of runA) {
      const runId = r.object_kind === ControlPlaneObjectKind.HANDOFF_RECORD
        ? (r as HandoffRecord).source_run_id
        : (r as GapRecord).detected_in_run_id;
      expect(runId).toBe("run-A");
    }

    const runB = repo.findByRunId("run-B");
    expect(runB).toHaveLength(1);

    const runC = repo.findByRunId("run-C");
    expect(runC).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteById
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — deleteById", () => {
  it("deletes handoff record by id", () => {
    const { repo } = createRepo();
    const record = makeHandoffRecord();
    repo.createHandoff(record);

    repo.deleteById(record.runtime_id);

    expect(repo.findHandoffById(record.runtime_id)).toBeNull();
  });

  it("deletes gap record by id", () => {
    const { repo } = createRepo();
    const record = makeGapRecord();
    repo.createGap(record);

    repo.deleteById(record.runtime_id);

    expect(repo.findGapById(record.runtime_id)).toBeNull();
  });

  it("deleteById does not throw for nonexistent id", () => {
    const { repo } = createRepo();
    expect(() => repo.deleteById("nonexistent")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteExpired + findExpiredObjects
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — TTL cleanup", () => {
  it("deleteExpired removes records with expires_at <= now and returns count", () => {
    const { repo } = createRepo();

    // expired records
    repo.createHandoff(makeHandoffRecord({
      runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expires_at: "2020-01-01T00:00:00.000Z"
    }));
    repo.createGap(makeGapRecord({
      runtime_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expires_at: "2020-01-01T00:00:00.000Z"
    }));
    // non-expired record
    repo.createHandoff(makeHandoffRecord({
      runtime_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      source_run_id: "run-source-2",
      expires_at: "2099-01-01T00:00:00.000Z"
    }));

    const deleted = repo.deleteExpired("2025-01-01T00:00:00.000Z");

    expect(deleted).toBe(2);
    expect(repo.findHandoffById("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeNull();
    expect(repo.findGapById("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeNull();
    expect(repo.findHandoffById("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).not.toBeNull();
  });

  it("deleteExpired returns 0 when nothing is expired", () => {
    const { repo } = createRepo();
    repo.createHandoff(makeHandoffRecord({ expires_at: "2099-01-01T00:00:00.000Z" }));

    const deleted = repo.deleteExpired("2025-01-01T00:00:00.000Z");
    expect(deleted).toBe(0);
  });

  it("findExpiredObjects returns tuples with object_kind, object_id, expires_at", () => {
    const { repo } = createRepo();

    repo.createHandoff(makeHandoffRecord({
      runtime_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expires_at: "2020-06-01T00:00:00.000Z"
    }));
    repo.createGap(makeGapRecord({
      runtime_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expires_at: "2020-07-01T00:00:00.000Z"
    }));
    repo.createHandoff(makeHandoffRecord({
      runtime_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      source_run_id: "run-source-2",
      expires_at: "2099-01-01T00:00:00.000Z"
    }));

    const expired = repo.findExpiredObjects("2025-01-01T00:00:00.000Z");

    expect(expired).toHaveLength(2);
    for (const obj of expired) {
      expect(obj).toHaveProperty("object_kind");
      expect(obj).toHaveProperty("object_id");
      expect(obj).toHaveProperty("expires_at");
      expect(obj.expires_at < "2025-01-01T00:00:00.000Z").toBe(true);
    }

    const kinds = expired.map((o) => o.object_kind);
    expect(kinds).toContain(ControlPlaneObjectKind.HANDOFF_RECORD);
    expect(kinds).toContain(ControlPlaneObjectKind.GAP_RECORD);
  });

  it("findExpiredObjects returns empty array when nothing is expired", () => {
    const { repo } = createRepo();
    repo.createHandoff(makeHandoffRecord({ expires_at: "2099-01-01T00:00:00.000Z" }));

    const expired = repo.findExpiredObjects("2025-01-01T00:00:00.000Z");
    expect(expired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("SqliteHandoffGapRepo — immutability", () => {
  it("mutating a returned HandoffRecord does not affect subsequent findById", () => {
    const { repo } = createRepo();
    const record = makeHandoffRecord();
    repo.createHandoff(record);

    const found = repo.findHandoffById(record.runtime_id);
    expect(found).not.toBeNull();

    // Attempt to mutate (TypeScript will prevent it, but we verify at runtime)
    try {
      (found as Record<string, unknown>)["handoff_kind"] = "MUTATED";
    } catch {
      // frozen object throws in strict mode — that is correct
    }

    const refetched = repo.findHandoffById(record.runtime_id);
    expect(refetched?.handoff_kind).toBe("session_end");
  });

  it("mutating a returned GapRecord does not affect subsequent findById", () => {
    const { repo } = createRepo();
    const record = makeGapRecord();
    repo.createGap(record);

    const found = repo.findGapById(record.runtime_id);
    expect(found).not.toBeNull();

    try {
      (found as Record<string, unknown>)["gap_kind"] = "MUTATED";
    } catch {
      // frozen object throws in strict mode — that is correct
    }

    const refetched = repo.findGapById(record.runtime_id);
    expect(refetched?.gap_kind).toBe("context_lost");
  });
});
