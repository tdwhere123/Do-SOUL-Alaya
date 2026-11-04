import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const previous = process.env.NODE_OPTIONS;
  const bootstrap = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${bootstrap}`.trim();
  return { ...installProviderFreeBoundary(), previous };
});
afterAll(() => {
  isolation.restore();
  if (isolation.previous === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = isolation.previous;
});
afterEach(() => { vi.unstubAllEnvs(); expect(isolation.violations).toEqual([]); });

import { CandidateMemorySignalSchema, RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteRunRepo, SqliteSignalRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../../index.js";
import { acquireTemporalRuntimeLease } from "../../../runtime/temporal-cutover/lease.js";

it("boots the real daemon with an interrupted signal under the OS lease before any materializer is activated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-startup-"));
  const config = join(realpathSync(tmpdir()), `alaya-bench-config-${randomUUID()}`);
  mkdirSync(config);
  const dataDir = join(directory, "data");
  mkdirSync(dataDir);
  const filename = join(dataDir, "alaya.db");
  const signal = CandidateMemorySignalSchema.parse({ signal_id: "interrupted-signal", workspace_id: "workspace-1",
    run_id: "run-1", surface_id: null, source: "model_tool", signal_kind: "potential_claim",
    signal_state: "compiled", object_kind: "scope", scope_hint: null, domain_tags: [], confidence: 0.8,
    evidence_refs: [], raw_payload: { excerpt: "Incomplete prior execution." }, created_at: "2026-03-18T00:00:00.000Z" });
  const priorLease = await acquireTemporalRuntimeLease(filename);
  const prior = initDatabase({ filename });
  await new SqliteWorkspaceRepo(prior).create({ workspace_id: "workspace-1", name: "Recovery", root_path: directory,
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(prior).create({ run_id: "run-1", workspace_id: "workspace-1", title: "Recovery",
    goal: null, run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null,
    run_state: RunState.IDLE, current_surface_id: null });
  const signals = new SqliteSignalRepo(prior);
  await signals.create(signal);
  await signals.updateState(signal.signal_id, "compiled");
  prior.close();
  await priorLease.release();
  for (const [key, value] of Object.entries({ DATA_DIR: dataDir, ALAYA_CONFIG_DIR: config,
    HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex-home"),
    ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx", ALAYA_SQLITE_WRITE_QUEUE: "0" })) {
    vi.stubEnv(key, value);
  }
  let runtime: AlayaDaemonRuntime | undefined;
  try {
    runtime = await createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" });
    await expect(acquireTemporalRuntimeLease(filename)).rejects.toThrow("must be stopped");
    const stored = initDatabase({ filename });
    expect((await new SqliteSignalRepo(stored).getById(signal.signal_id))?.signal_state).toBe("materialization_unknown");
    expect(await runtime.services.signalService.receiveSignal(signal)).toMatchObject({
      signal: { signal_state: "materialization_unknown" }, triage_result: "unknown", materialization: null
    });
    expect(stored.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    const audit = stored.connection.prepare("SELECT payload_json FROM event_log WHERE entity_id=? AND event_type='soul.signal.normalized'")
      .get(signal.signal_id) as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ normalized_fields: { materialization_recovery: {
      disposition: "effects_unknown", requires_inspection: true, automatic_replay: false } } });
    await runtime.shutdown();
    runtime = undefined;
    const successor = await acquireTemporalRuntimeLease(filename);
    await successor.release();
  } finally {
    try { await runtime?.shutdown(); }
    finally { rmSync(directory, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true }); }
  }
}, 45_000);
