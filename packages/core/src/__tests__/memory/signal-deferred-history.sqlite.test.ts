import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({
    ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../apps/bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, SqliteRunRepo, SqliteSignalRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { SignalService } from "../../memory/signal-service.js";
import { createSignal } from "./signal-service.test-support.js";

afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-history-"));
  const database = initDatabase({ filename: join(directory, "alaya.db") });
  await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "history",
    root_path: directory, workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "history",
    goal: null, run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null,
    run_state: RunState.IDLE, current_surface_id: null });
  const signal = createSignal();
  const events = new SqliteEventLogRepo(database);
  let available = false;
  const materialize = vi.fn(async () => available ? {
    signal_id: signal.signal_id, target_kind: "evidence_only" as const, routing_reason: "write path available",
    created_objects: [], success: true as const
  } : {
    signal_id: signal.signal_id, target_kind: "deferred" as const, routing_reason: "write path unavailable",
    created_objects: [], success: true as const, defer_class: "write_path" as const,
    deferral: "prewrite_unavailable" as const
  });
  const service = new SignalService({ eventLogRepo: events, signalRepo: new SqliteSignalRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, postTriageMaterializer: { materialize } });
  expect((await service.receiveSignal(signal)).signal.signal_state).toBe("deferred");
  return { directory, database, signal, events, service, materialize, makeAvailable: () => { available = true; } };
}

it("retries a safe deferral after more than ten thousand entity audits", async () => {
  const f = await fixture();
  try {
    const rows = await f.events.queryByEntity("candidate_memory_signal", f.signal.signal_id);
    const deferred = rows.find(row => row.event_type === "soul.signal.materialized")!;
    const triaged = rows.filter(row => row.event_type === "soul.signal.triaged").at(-1)!;
    const insert = f.database.connection.prepare(`INSERT INTO event_log
      (event_id,event_type,entity_type,entity_id,workspace_id,run_id,caused_by,revision,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const revision = Math.max(...rows.map(row => row.revision));
    f.database.connection.transaction(() => {
      for (let i = 0; i < 10020; i += 1) {
        const source = i % 2 === 0 ? deferred : triaged;
        insert.run(`bulk-${i}`, source.event_type, source.entity_type, source.entity_id, source.workspace_id,
          source.run_id, source.caused_by, revision + i + 1, JSON.stringify(source.payload_json), source.created_at);
      }
    })();
    await expect(f.events.queryByEntityAll("candidate_memory_signal", f.signal.signal_id)).rejects.toThrow("hard cap");
    f.makeAvailable();
    expect((await f.service.receiveSignal(f.signal)).signal.signal_state).toBe("materialized");
    expect(f.materialize).toHaveBeenCalledTimes(2);
    const stored = await new SqliteSignalRepo(f.database).getById(f.signal.signal_id);
    expect(stored?.signal_state).toBe("materialized");
  } finally { f.database.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

it("does not claim a newer deferral using stale retry evidence after a concurrent attempt", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const query = f.events.queryByEntityTypeBefore.bind(f.events);
  let intercept = true;
  f.events.queryByEntityTypeBefore = async (...args) => {
    if (intercept && args[2] === "soul.signal.emitted") {
      intercept = false; entered(); await gate;
    }
    return await query(...args);
  };
  try {
    const stale = f.service.receiveSignal(f.signal);
    await started;
    expect((await f.service.receiveSignal(f.signal)).signal.signal_state).toBe("deferred");
    release();
    expect((await stale).signal.signal_state).toBe("deferred");
    expect(f.materialize).toHaveBeenCalledTimes(2);
  } finally { release(); f.database.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

it("fails closed on malformed retry evidence and retries after it is repaired", async () => {
  const f = await fixture();
  try {
    const audit = f.database.connection.prepare(`SELECT event_id, payload_json FROM event_log
      WHERE entity_id=? AND event_type='soul.signal.triaged' ORDER BY revision DESC LIMIT 1`)
      .get(f.signal.signal_id) as { event_id: string; payload_json: string };
    const update = f.database.connection.prepare("UPDATE event_log SET payload_json=? WHERE event_id=?");
    update.run("{}", audit.event_id);
    f.makeAvailable();
    await expect(f.service.receiveSignal(f.signal)).rejects.toThrow("triage audit is malformed");
    expect(f.materialize).toHaveBeenCalledTimes(1);
    update.run(audit.payload_json, audit.event_id);
    expect((await f.service.receiveSignal(f.signal)).signal.signal_state).toBe("materialized");
    expect(f.materialize).toHaveBeenCalledTimes(2);
  } finally { f.database.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
