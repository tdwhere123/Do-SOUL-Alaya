import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
import { acquireTemporalRuntimeLease } from "../../runtime/temporal-cutover/lease.js";
import { closeDaemonSqliteWriteQueue } from "../../runtime/startup/database.js";
import { openRuntimeDatabase } from "../../runtime/startup/runtime-database.js";
import { createRuntimeNotifier } from "../../runtime/daemon/support/runtime-notifier.js";
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
  getSqliteWriteQueuePort,
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { registerSignalRoutes, type SignalRouteServices } from "../../routes/workspace/signals.js";
import { startOwnedTestChild } from "../support/owned-child-process.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];
const children: ReturnType<typeof startOwnedTestChild>[] = [];
afterAll(() => isolation.restore());

afterEach(async () => {
  for (const child of children.splice(0)) await child.stop();
  for (const database of databases.splice(0)) {
    if (!database.isClosed()) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  expect(isolation.violations).toEqual([]);
});

describe("compiled signal resume through storage and signal routes", () => {
  it.for([
    { outcome: "successful assertions", failAfterRestart: false },
    { outcome: "failed assertions", failAfterRestart: true }
  ])("keeps compiled signals unknown after restart and releases resources after $outcome", async ({ failAfterRestart }, { signal: abortSignal }) => {
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
    try { await seedCompiledCrash(seeded, signal); }
    finally { seeded.close(); }
    // The child owns the exact production lease. OS process death, not a PID
    // heuristic or caller flag, establishes release before startup recovery.
    const leaseModule = new URL("../../../dist/runtime/temporal-cutover/lease.js", import.meta.url).href;
    const child = startOwnedTestChild(["--input-type=module", "-e", `
      const { acquireTemporalRuntimeLease } = await import(${JSON.stringify(leaseModule)});
      await acquireTemporalRuntimeLease(${JSON.stringify(filename)});
      console.log('owned'); setInterval(() => {}, 1000);
    `], abortSignal);
    children.push(child);
    try {
      await child.waitForStdout("owned\n");
      await expect(acquireTemporalRuntimeLease(filename)).rejects.toThrow("must be stopped");
    } finally {
      await child.stop();
    }
    abortSignal.throwIfAborted();
    const { database: reopened, temporalRuntimeLease: restartLease } = await openRuntimeDatabase(
      filename, createRuntimeNotifier(), () => undefined
    );
    databases.push(reopened);
    const checkRestartedState = async () => {
      try { await assertRecoveredSignalRoutes(reopened, signal, failAfterRestart); }
      finally {
        await closeDaemonSqliteWriteQueue();
        try { reopened.close(); }
        finally { await restartLease.release(); }
      }
    };
    if (failAfterRestart) await expect(checkRestartedState()).rejects.toThrow("injected restarted assertion failure");
    else await checkRestartedState();
    expect(reopened.isClosed()).toBe(true);
    expect(getSqliteWriteQueuePort()).toBeNull();
    const nextLease = await acquireTemporalRuntimeLease(filename);
    await nextLease.release();
    expect(isolation.violations).toEqual([]);
  });
});

async function assertRecoveredSignalRoutes(
  reopened: StorageDatabase, signal: CandidateMemorySignal, failAfterRestart: boolean
): Promise<void> {
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
    postTriageMaterializer: { materialize }
  });

  try {
    if (failAfterRestart) throw new Error("injected restarted assertion failure");
    expect(materialize).not.toHaveBeenCalled();
    expect(await signalService.receiveSignal(signal)).toMatchObject({
      signal: { signal_state: "materialization_unknown" }, triage_result: "unknown", materialization: null
    });

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
      data: [{ signal_id: signal.signal_id, signal_state: "materialization_unknown" }]
    });
    await expect(signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialization_unknown"
    });
    const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id);
    expect(events.at(-1)?.payload_json).toMatchObject({ normalized_fields: {
      materialization_recovery: { disposition: "effects_unknown", requires_inspection: true, automatic_replay: false }
    } });
  } finally { await signalService.close(); }
}

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
