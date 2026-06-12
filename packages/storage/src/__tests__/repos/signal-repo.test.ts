import { afterEach, describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteSignalRepo } from "../../repos/signal-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  const { signal_state, ...restOverrides } = overrides;

  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: signal_state ?? "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.5,
    evidence_refs: ["msg-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { excerpt: "Never print secrets." },
    created_at: "2026-03-18T00:00:00.000Z",
    ...restOverrides
  };
}

describe("SqliteSignalRepo", () => {
  it("creates and loads a signal by id", async () => {
    const { signalRepo } = await createSignalRepo();
    const signal = createSignal();

    await expect(signalRepo.create(signal)).resolves.toEqual(signal);
    await expect(signalRepo.getById(signal.signal_id)).resolves.toEqual(signal);
  });

  it("forces emitted state when creating a signal", async () => {
    const { database, signalRepo } = await createSignalRepo();
    const signal = createSignal({
      signal_id: "signal-create-state",
      signal_state: "normalized"
    });

    const created = await signalRepo.create(signal);
    const loaded = await signalRepo.getById(signal.signal_id);
    const stored = database.connection
      .prepare("SELECT signal_state FROM signals WHERE signal_id = ?")
      .get(signal.signal_id) as { readonly signal_state: string };

    expect(created.signal_state).toBe("emitted");
    expect(loaded?.signal_state).toBe("emitted");
    expect(stored.signal_state).toBe("emitted");
  });

  it("lists only signals for the requested run", async () => {
    const { signalRepo } = await createSignalRepo();

    await signalRepo.create(createSignal({ signal_id: "signal-1", run_id: "run-1" }));
    await signalRepo.create(createSignal({ signal_id: "signal-2", run_id: "run-1" }));
    await signalRepo.create(createSignal({ signal_id: "signal-3", run_id: "run-2" }));

    const signals = await signalRepo.listByRun("run-1");

    expect(signals.map((signal) => signal.signal_id)).toEqual(["signal-1", "signal-2"]);
  });

  it("updates signal_state on the public signal shape", async () => {
    const { database, signalRepo } = await createSignalRepo();
    const signal = createSignal();
    await signalRepo.create(signal);

    const updated = await signalRepo.updateState(signal.signal_id, "normalized");
    const stored = database.connection
      .prepare("SELECT signal_state FROM signals WHERE signal_id = ?")
      .get(signal.signal_id) as { readonly signal_state: string };

    expect(updated).toEqual({
      ...signal,
      signal_state: "normalized"
    });
    expect(stored.signal_state).toBe("normalized");
  });

  it("round-trips first-class memory refs outside raw_payload", async () => {
    const { database, signalRepo } = await createSignalRepo();
    const signal = createSignal({
      signal_id: "signal-memory-refs",
      source_memory_refs: ["memory-source-1"],
      supersedes_refs: ["memory-old-1"],
      exception_to_refs: ["memory-rule-1"],
      contradicts_refs: ["memory-conflict-1"],
      incompatible_with_refs: ["memory-incompat-1"],
      raw_payload: { excerpt: "Refs are first-class fields." }
    });

    await signalRepo.create(signal);

    const loaded = await signalRepo.getById(signal.signal_id);
    const stored = database.connection
      .prepare(
        `SELECT
           source_memory_refs_json,
           supersedes_refs_json,
           exception_to_refs_json,
           contradicts_refs_json,
           incompatible_with_refs_json,
           raw_payload_json
         FROM signals
         WHERE signal_id = ?`
      )
      .get(signal.signal_id) as {
        readonly source_memory_refs_json: string;
        readonly supersedes_refs_json: string;
        readonly exception_to_refs_json: string;
        readonly contradicts_refs_json: string;
        readonly incompatible_with_refs_json: string;
        readonly raw_payload_json: string;
      };

    expect(loaded).toEqual(signal);
    expect(JSON.parse(stored.source_memory_refs_json)).toEqual(["memory-source-1"]);
    expect(JSON.parse(stored.supersedes_refs_json)).toEqual(["memory-old-1"]);
    expect(JSON.parse(stored.exception_to_refs_json)).toEqual(["memory-rule-1"]);
    expect(JSON.parse(stored.contradicts_refs_json)).toEqual(["memory-conflict-1"]);
    expect(JSON.parse(stored.incompatible_with_refs_json)).toEqual(["memory-incompat-1"]);
    expect(JSON.parse(stored.raw_payload_json)).not.toHaveProperty("source_memory_refs");
  });
});

async function createSignalRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly signalRepo: SqliteSignalRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "signal run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "signal run 2",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    signalRepo: new SqliteSignalRepo(database)
  };
}
