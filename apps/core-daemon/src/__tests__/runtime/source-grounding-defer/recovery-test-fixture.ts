import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { SignalService, bindEventPublisher, createSignalEmissionWriter } from "@do-soul/alaya-core";
import { CandidateMemorySignalSchema, RunMode, RunState, WorkspaceKind, WorkspaceState, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, SqliteRunRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo, SqliteWorkspaceRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceGroundingDeferTransitions } from "../../../runtime/source-grounding-defer/transitions.js";
import { createAlayaCliBridge, type AlayaCliDaemonRuntime } from "../../../cli/bridge.js";
import { createSourceGroundingDefersCommand } from "../../../cli/source-grounding-defers/command.js";

export function candidate(signalId: string): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({ signal_id: signalId, workspace_id: "workspace-1", run_id: "run-1",
    surface_id: null, source: "user_seed", signal_kind: "potential_preference", signal_state: "emitted",
    object_kind: "memory_entry", scope_hint: "project", domain_tags: [], confidence: 0.9, evidence_refs: [],
    raw_payload: { observation: "Use pnpm." }, source_observation: null, created_at: "2026-03-21T00:00:00.000Z" });
}

export function connect(database: StorageDatabase, cap = 2) {
  const signals = new SqliteSignalRepo(database), events = new SqliteEventLogRepo(database);
  const queue = new SqliteSourceGroundingDeferQueueRepo(database, cap);
  const transitions = createSourceGroundingDeferTransitions({ eventLogRepo: events, signalRepo: signals, queueRepo: queue });
  let disposition: "deferred" | "materialized" | "failed" = "deferred";
  const materialize = vi.fn(async (signal: CandidateMemorySignal) => {
    if (disposition === "failed") throw new Error("materializer effect outcome unknown");
    return disposition === "materialized" ? { signal_id: signal.signal_id, target_kind: "evidence_only" as const,
      routing_reason: "fixture accepted", success: true as const, created_objects: [] } : {
      signal_id: signal.signal_id, target_kind: "deferred" as const, success: true as const, created_objects: [],
      routing_reason: "garden source grounding failed: source_assertion_incomplete", defer_class: "source_grounding" as const,
      defer_reason: "source_assertion_incomplete" as const };
  });
  const notifyEntry = vi.fn(async () => undefined), warn = vi.fn();
  const eventPublisher = bindEventPublisher({ eventLogRepo: events, runtimeNotifier: { notifyEntry }, purpose: "recovery fixture" });
  const service = new SignalService({ signalRepo: signals, eventLogRepo: events, sourceGroundingDeferQueue: queue,
    sourceGroundingDeferTransitions: transitions, emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo: signals }),
    runtimeNotifier: { notifyEntry }, postTriageMaterializer: { materialize }, warn });
  return { database, signals, events, queue, transitions, service, materialize, notifyEntry,
    outcome: (value: typeof disposition) => { disposition = value; } };
}

export async function fixture(cap = 2) {
  const directory = mkdtempSync(join(tmpdir(), "alaya-defer-recovery-")), filename = join(directory, "alaya.db");
  let database = initDatabase({ filename });
  await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "recovery", root_path: directory,
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "recovery", goal: null,
    run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  let owner = connect(database, cap);
  return { get owner() { return owner; }, filename,
    reopen: async () => { await owner.service.close(); database.close(); database = initDatabase({ filename }); owner = connect(database, cap); },
    close: async () => { await owner.service.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

export function cli(service: SignalService) {
  let stdout = "", stderr = "";
  const out = new PassThrough(), err = new PassThrough();
  out.on("data", chunk => { stdout += String(chunk); }); err.on("data", chunk => { stderr += String(chunk); });
  const bridge = createAlayaCliBridge({ startupSteps: [{ step: "http-app" }] } as unknown as AlayaCliDaemonRuntime,
    { stdout: out, stderr: err, stdin: new PassThrough(), isTTY: false });
  bridge.registerSubcommand(createSourceGroundingDefersCommand({ signalService: service }));
  return { run: async (args: string[]) => {
    stdout = ""; stderr = "";
    const result = await bridge.dispatch(["source-grounding-defers", ...args, "--workspace", "workspace-1", "--json"]);
    return { result, stdout, stderr, json: stdout.length === 0 ? undefined : JSON.parse(stdout) };
  } };
}
