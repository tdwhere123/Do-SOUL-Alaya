import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  CandidateMemorySignalSchema,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { SignalService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { registerSignalRoutes, type SignalRouteServices } from "../../routes/workspace/signals.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (!database.isClosed()) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("compiled signal resume through storage and signal routes", () => {
  it("lists a compiled crash as still compiled after restart resume without a materialization witness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-signal-route-compiled-"));
    directories.push(directory);
    const filename = join(directory, "alaya.db");
    const signal = CandidateMemorySignalSchema.parse({
      signal_id: "signal-compiled-route-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source: "user_seed",
      signal_kind: "potential_claim",
      signal_state: "compiled",
      object_kind: "constraint",
      scope_hint: null,
      domain_tags: ["security"],
      confidence: 0.7,
      evidence_refs: ["msg-1"],
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: [],
      raw_payload: { excerpt: "Never print secrets." },
      source_observation: null,
      created_at: "2026-03-18T00:00:00.000Z"
    });

    const seeded = initDatabase({ filename });
    await seedCompiledCrash(seeded, signal);
    seeded.close();

    const reopened = initDatabase({ filename });
    databases.push(reopened);
    const eventLogRepo = new SqliteEventLogRepo(reopened);
    const signalRepo = new SqliteSignalRepo(reopened);
    const runRepo = new SqliteRunRepo(reopened);
    const materialize = vi.fn(async () => {
      throw new Error("compiled crash must not rematerialize");
    });
    const signalService = new SignalService({
      eventLogRepo,
      signalRepo,
      runtimeNotifier: { notifyEntry: vi.fn(async () => {}) },
      postTriageMaterializer: {
        materialize: async (candidate, context) => await materialize(candidate, context)
      }
    });

    const results = await signalService.resumeInterruptedMaterialization();
    expect(materialize).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.signal.signal_state).toBe("compiled");
    expect(results[0]?.triage_result).toBe("deferred");
    expect(results[0]?.materialization).toBeNull();

    const app = new Hono();
    registerSignalRoutes(app, {
      runService: {
        getById: async (runId) => {
          const run = await runRepo.getById(runId);
          if (run === null) throw new Error(`missing run ${runId}`);
          return run;
        }
      } as SignalRouteServices["runService"],
      signalService
    });

    const response = await app.request("/runs/run-1/signals");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      readonly success: boolean;
      readonly data: ReadonlyArray<{ readonly signal_id: string; readonly signal_state: string }>;
    };
    expect(body).toMatchObject({
      success: true,
      data: [{ signal_id: signal.signal_id, signal_state: "compiled" }]
    });
    await expect(signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "compiled"
    });
  });
});

async function seedCompiledCrash(database: StorageDatabase, signal: CandidateMemorySignal): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: signal.workspace_id,
    name: "compiled route resume",
    root_path: "/tmp/compiled-route-resume",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    title: "compiled route resume",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const signalRepo = new SqliteSignalRepo(database);
  await signalRepo.create(signal);
  await signalRepo.updateState(signal.signal_id, "compiled");
  const eventLogRepo = new SqliteEventLogRepo(database);
  await eventLogRepo.append({
    event_type: "soul.signal.emitted",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: signal.source,
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      source: signal.source,
      signal_kind: signal.signal_kind,
      source_observation: null,
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: [],
      raw_payload: {
        raw_payload_redacted: true,
        raw_payload_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        raw_payload_key_count: 1
      }
    }
  });
  await eventLogRepo.append({
    event_type: "soul.signal.triaged",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "deterministic_rule",
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      triage_result: "accepted"
    }
  });
}
