import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateMemorySignalSchema, FormationKind, MemoryDimension, RunMode, RunState, ScopeClass, SourceKind,
  StorageTier, WorkspaceKind, WorkspaceState, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { SignalService, createSignalEmissionWriter, bindEventPublisher,
  fingerprintSourceGroundingClaimToken } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo, SqliteRunRepo, SqliteSignalRepo,
  SqliteSourceGroundingDeferQueueRepo, SqliteWorkspaceRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { openRuntimeDatabase } from "../../../runtime/startup/runtime-database.js";
import { closeDaemonSqliteWriteQueue } from "../../../runtime/startup/database.js";
import { createRuntimeNotifier } from "../../../runtime/daemon/support/runtime-notifier.js";
import { createSourceGroundingDeferTransitions } from "../../../runtime/source-grounding-defer/transitions.js";

afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());

function signal(id: string): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({ signal_id: id, workspace_id: "workspace-1", run_id: "run-1",
    surface_id: null, source: "user_seed", signal_kind: "potential_preference", signal_state: "emitted",
    object_kind: "memory_entry", scope_hint: "project", domain_tags: [], confidence: 0.9, evidence_refs: [],
    source_memory_refs: [], supersedes_refs: [], exception_to_refs: [], contradicts_refs: [], incompatible_with_refs: [],
    raw_payload: { observation: "Use pnpm." }, source_observation: null, created_at: "2026-03-21T00:00:00.000Z" });
}

async function seed(filename: string) {
  const database = initDatabase({ filename });
  await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "recovery", root_path: "/tmp/recovery",
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "recovery", goal: null,
    run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  return database;
}

function service(database: StorageDatabase, materialize?: ConstructorParameters<typeof SignalService>[0]["postTriageMaterializer"]) {
  const signalRepo = new SqliteSignalRepo(database), eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = createRuntimeNotifier();
  const eventPublisher = bindEventPublisher({ eventLogRepo, runtimeNotifier, purpose: "recovery fixture" });
  return new SignalService({ signalRepo, eventLogRepo, runtimeNotifier,
    emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }),
    ...(materialize === undefined ? {} : { postTriageMaterializer: materialize }) });
}

async function closeOwner(owner: Awaited<ReturnType<typeof openRuntimeDatabase>>) {
  await closeDaemonSqliteWriteQueue();
  owner.database.close();
  await owner.temporalRuntimeLease.release();
}

it("retains a partial memory behind historical TRIAGED while a genuinely new triage resumes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-provenance-"));
  const filename = join(directory, "alaya.db");
  const database = await seed(filename);
  const historical = signal("historical"), safe = signal("new-pre-effect");
  const oldDeferred = signal("historical-write-path"), safeDeferred = signal("new-write-path");
  const missingEvidence = signal("historical-no-triage"), malformedEvidence = signal("historical-malformed-triage");
  const provenRejected = signal("historical-deferred-triage");
  const signals = new SqliteSignalRepo(database);
  await signals.create(historical);
  await signals.updateState(historical.signal_id, "compiled");
  await new SqliteMemoryEntryRepo(database).create({ object_id: "00000000-0000-4000-8000-000000000011", object_kind: "memory_entry",
    schema_version: 1, lifecycle_state: "active", created_at: "2026-03-21T00:00:00.000Z", updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action", dimension: MemoryDimension.PREFERENCE, source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT, content: "Use pnpm.", domain_tags: [], evidence_refs: [], workspace_id: "workspace-1",
    run_id: "run-1", surface_id: null, storage_tier: StorageTier.HOT, activation_score: null, retention_score: null,
    manifestation_state: null, retention_state: null, decay_profile: null, confidence: null, last_used_at: null,
    last_hit_at: null, reinforcement_count: null, contradiction_count: null, superseded_by: null });
  // Reproduce the old stale-EMITTED receiver's unconditional overwrite after an effect committed.
  await signals.updateState(historical.signal_id, "triaged");
  const admission = service(database);
  expect((await admission.receiveSignal(safe)).signal.signal_state).toBe("triaged");
  await admission.close();
  const deferring = service(database, { materialize: async current => ({ signal_id: current.signal_id,
    target_kind: "deferred", routing_reason: "write path unavailable", created_objects: [], success: true,
    defer_class: "write_path", deferral: "prewrite_unavailable" }) });
  expect((await deferring.receiveSignal(oldDeferred)).signal.signal_state).toBe("deferred");
  expect((await deferring.receiveSignal(safeDeferred)).signal.signal_state).toBe("deferred");
  await deferring.close();
  // Old concurrent redrives both overwrote COMPILED; the first completed a
  // deferral while the other could have left effects before process death.
  await signals.updateState(oldDeferred.signal_id, "compiled");
  await signals.updateState(oldDeferred.signal_id, "deferred");
  for (const row of [missingEvidence, malformedEvidence, provenRejected]) {
    await signals.create(row);
    await signals.updateState(row.signal_id, "deferred");
  }
  const events = new SqliteEventLogRepo(database);
  for (const row of [malformedEvidence, provenRejected]) await events.append({
    event_type: "soul.signal.triaged", entity_type: "candidate_memory_signal", entity_id: row.signal_id,
    workspace_id: row.workspace_id, run_id: row.run_id, caused_by: "deterministic_rule",
    payload_json: row === malformedEvidence ? { invalid: true } : {
      signal_id: row.signal_id, workspace_id: row.workspace_id, run_id: row.run_id, triage_result: "deferred"
    }
  });
  database.close();
  const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
  try {
    const materialize = vi.fn(async (candidate: CandidateMemorySignal) => ({ signal_id: candidate.signal_id,
      target_kind: "evidence_only" as const, routing_reason: "safe admission", created_objects: [], success: true as const }));
    const resumed = service(owner.database, { materialize });
    expect("recoverInterruptedMaterialization" in resumed).toBe(false);
    expect(await resumed.receiveSignal(historical)).toMatchObject({ signal: { signal_state: "materialization_unknown" },
      triage_result: "unknown", materialization: null });
    expect(await resumed.receiveSignal(oldDeferred)).toMatchObject({ signal: { signal_state: "materialization_unknown" },
      triage_result: "unknown", materialization: null });
    const recoveredSignals = new SqliteSignalRepo(owner.database);
    expect((await recoveredSignals.getById(missingEvidence.signal_id))?.signal_state).toBe("materialization_unknown");
    expect((await recoveredSignals.getById(malformedEvidence.signal_id))?.signal_state).toBe("materialization_unknown");
    expect((await recoveredSignals.getById(provenRejected.signal_id))?.signal_state).toBe("deferred");
    expect(materialize).not.toHaveBeenCalled();
    expect((await resumed.receiveSignal(safe)).signal.signal_state).toBe("materialized");
    expect((await resumed.receiveSignal(safeDeferred)).signal.signal_state).toBe("materialized");
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(await new SqliteMemoryEntryRepo(owner.database).findById("00000000-0000-4000-8000-000000000011"))
      .toMatchObject({ content: "Use pnpm." });
    expect((owner.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number }).n).toBe(1);
    const audits = await new SqliteEventLogRepo(owner.database).queryByEntity("candidate_memory_signal", historical.signal_id);
    expect(audits.at(-1)?.payload_json).toMatchObject({ normalized_fields: { materialization_recovery: {
      previous_state: "triaged", disposition: "effects_unknown", automatic_replay: false, requires_inspection: true } } });
    const deferredAudits = await new SqliteEventLogRepo(owner.database).queryByEntity("candidate_memory_signal", oldDeferred.signal_id);
    expect(deferredAudits.at(-1)?.payload_json).toMatchObject({ normalized_fields: { materialization_recovery: {
      previous_state: "deferred", disposition: "effects_unknown", automatic_replay: false } } });
    await resumed.close();
  } finally { await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});

it("retains an interrupted grounding claim as unknown while an unclaimed safe deferral can redrive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-grounding-recovery-"));
  const filename = join(directory, "alaya.db"), db = await seed(filename);
  const signals = new SqliteSignalRepo(db), events = new SqliteEventLogRepo(db);
  const queue = new SqliteSourceGroundingDeferQueueRepo(db), notifier = createRuntimeNotifier();
  const transitions = createSourceGroundingDeferTransitions({ eventLogRepo: events, signalRepo: signals, queueRepo: queue });
  const defer = new SignalService({ eventLogRepo: events, signalRepo: signals, runtimeNotifier: notifier,
    sourceGroundingDeferQueue: queue, sourceGroundingDeferTransitions: transitions,
    postTriageMaterializer: { materialize: async current => ({ signal_id: current.signal_id,
      target_kind: "deferred", routing_reason: "source grounding unavailable", created_objects: [], success: true,
      defer_class: "source_grounding", defer_reason: "source_assertion_not_self_contained" }) } });
  const interrupted = signal("claimed-grounding"), safe = signal("unclaimed-grounding");
  expect((await defer.receiveSignal(interrupted)).signal.signal_state).toBe("deferred");
  expect((await defer.receiveSignal(safe)).signal.signal_state).toBe("deferred");
  expect(queue.claim("workspace-1", interrupted.signal_id, "prior-claim",
    fingerprintSourceGroundingClaimToken("prior-claim"), "2026-01-01T00:00:00.000Z")).not.toBeNull();
  await defer.close(); db.close();
  const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
  try {
    const currentSignals = new SqliteSignalRepo(owner.database), currentEvents = new SqliteEventLogRepo(owner.database);
    const currentQueue = new SqliteSourceGroundingDeferQueueRepo(owner.database), currentNotifier = createRuntimeNotifier();
    expect((await currentSignals.getById(interrupted.signal_id))?.signal_state).toBe("materialization_unknown");
    expect((await currentSignals.getById(safe.signal_id))?.signal_state).toBe("deferred");
    const materialize = vi.fn(async (current: CandidateMemorySignal) => ({ signal_id: current.signal_id,
      target_kind: "evidence_only" as const, routing_reason: "safe redrive", created_objects: [], success: true as const }));
    const resumed = new SignalService({ eventLogRepo: currentEvents, signalRepo: currentSignals, runtimeNotifier: currentNotifier,
      sourceGroundingDeferQueue: currentQueue, sourceGroundingDeferTransitions: createSourceGroundingDeferTransitions({
        eventLogRepo: currentEvents, signalRepo: currentSignals, queueRepo: currentQueue }), postTriageMaterializer: { materialize } });
    await expect(resumed.redriveSourceGroundingDefer("workspace-1", interrupted.signal_id)).rejects.toThrow();
    expect(materialize).not.toHaveBeenCalled();
    expect((await resumed.redriveSourceGroundingDefer("workspace-1", safe.signal_id)).signal.signal_state).toBe("materialized");
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(currentQueue.get("workspace-1", interrupted.signal_id)).not.toBeNull();
    await resumed.close();
  } finally { await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});

it("does not reconcile an expired grounding claim while its materializer is live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-grounding-live-"));
  const filename = join(directory, "alaya.db");
  (await seed(filename)).close();
  const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
  const signals = new SqliteSignalRepo(owner.database), events = new SqliteEventLogRepo(owner.database);
  const queue = new SqliteSourceGroundingDeferQueueRepo(owner.database), notifier = createRuntimeNotifier();
  const transitions = createSourceGroundingDeferTransitions({ eventLogRepo: events, signalRepo: signals, queueRepo: queue });
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const candidate = signal("live-grounding");
  const active = new SignalService({ eventLogRepo: events, signalRepo: signals, runtimeNotifier: notifier,
    sourceGroundingDeferQueue: queue, sourceGroundingDeferTransitions: transitions,
    postTriageMaterializer: { materialize: async current => {
      calls += 1;
      if (calls === 1) return { signal_id: current.signal_id, target_kind: "deferred", routing_reason: "grounding deferred",
        created_objects: [], success: true, defer_class: "source_grounding", defer_reason: "source_assertion_not_self_contained" };
      entered(); await gate;
      return { signal_id: current.signal_id, target_kind: "deferred", routing_reason: "prewrite unavailable",
        created_objects: [], success: true, defer_class: "write_path", deferral: "prewrite_unavailable" };
    } } });
  const peerMaterialize = vi.fn(async (current: CandidateMemorySignal) => ({ signal_id: current.signal_id,
    target_kind: "evidence_only" as const, routing_reason: "explicit retry", created_objects: [], success: true as const }));
  const peer = new SignalService({ eventLogRepo: events, signalRepo: signals, runtimeNotifier: notifier,
    sourceGroundingDeferQueue: queue, sourceGroundingDeferTransitions: transitions, postTriageMaterializer: { materialize: peerMaterialize } });
  try {
    expect((await active.receiveSignal(candidate)).signal.signal_state).toBe("deferred");
    const running = active.redriveSourceGroundingDefer("workspace-1", candidate.signal_id);
    await started;
    const expiry = "2026-01-01T00:00:00.000Z";
    owner.database.connection.prepare("UPDATE source_grounding_defer_queue SET claim_expires_at=? WHERE signal_id=?")
      .run(expiry, candidate.signal_id);
    const fingerprint = queue.get("workspace-1", candidate.signal_id)?.claim_token_fingerprint;
    expect(fingerprint).toBeTruthy();
    const reconcile = () => peer.reconcileStaleSourceGroundingRedrive({ workspaceId: "workspace-1", signalId: candidate.signal_id,
      claimTokenFingerprint: fingerprint!, expectedClaimExpiresAt: expiry, reason: "inspect claim" });
    await expect(reconcile()).rejects.toThrow("no completion witness");
    await expect(peer.redriveSourceGroundingDefer("workspace-1", candidate.signal_id)).rejects.toThrow();
    expect(peerMaterialize).not.toHaveBeenCalled();
    expect(queue.hasUnfinishedClaim("workspace-1", candidate.signal_id)).toBe(true);
    release();
    expect((await running).signal.signal_state).toBe("deferred");
    expect(queue.hasUnfinishedClaim("workspace-1", candidate.signal_id)).toBe(false);
    expect((await reconcile()).signal_state).toBe("deferred");
    expect((await peer.redriveSourceGroundingDefer("workspace-1", candidate.signal_id)).signal.signal_state).toBe("materialized");
    expect(peerMaterialize).toHaveBeenCalledTimes(1);
    await active.close(); await peer.close();
  } finally { release(); await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});

it("does not manufacture pre-effect lineage when a pre-041 database is upgraded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-migration-"));
  const filename = join(directory, "alaya.db"), candidate = signal("legacy-triaged");
  const database = await seed(filename), signals = new SqliteSignalRepo(database);
  await signals.create(candidate);
  await signals.updateState(candidate.signal_id, "triaged");
  database.connection.exec(`ALTER TABLE signals DROP COLUMN materialization_lineage_proven;
    ALTER TABLE enrich_pending DROP COLUMN independent_processed_at;
    ALTER TABLE enrich_pending DROP COLUMN signal_ref_waiting;
    ALTER TABLE source_grounding_defer_queue DROP COLUMN claim_started_revision;
    DELETE FROM schema_version WHERE version=41`);
  database.close();
  const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
  try {
    const row = owner.database.connection.prepare("SELECT signal_state,materialization_lineage_proven FROM signals WHERE signal_id=?")
      .get(candidate.signal_id) as { signal_state: string; materialization_lineage_proven: number };
    expect(row).toEqual({ signal_state: "materialization_unknown", materialization_lineage_proven: 0 });
    expect((owner.database.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number }).version).toBe(41);
  } finally { await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});

it("does not allow a live owner or another database to recover an active attempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-active-owner-"));
  const filename = join(directory, "owner.db"), otherFilename = join(directory, "other.db");
  (await seed(filename)).close();
  const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const candidate = signal("active");
  const active = service(owner.database, { materialize: async current => {
    started(); await gate;
    return { signal_id: current.signal_id, target_kind: "evidence_only", routing_reason: "active owner",
      created_objects: [], success: true };
  } });
  try {
    const running = active.receiveSignal(candidate);
    await entered;
    expect((await new SqliteSignalRepo(owner.database).getById(candidate.signal_id))?.signal_state).toBe("compiled");
    expect("recoverInterruptedMaterialization" in active).toBe(false);
    expect("recoverSignalsBeforeActivation" in owner.temporalRuntimeLease).toBe(false);
    await expect(openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined)).rejects.toThrow("must be stopped");
    const other = await openRuntimeDatabase(otherFilename, createRuntimeNotifier(), () => undefined);
    await closeOwner(other);
    expect((await new SqliteSignalRepo(owner.database).getById(candidate.signal_id))?.signal_state).toBe("compiled");
    release();
    expect((await running).signal.signal_state).toBe("materialized");
    await active.close();
  } finally { release(); await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});

it("rolls back a rejected recovery audit and retries only after the database can commit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-recovery-rollback-"));
  const filename = join(directory, "alaya.db"), candidate = signal("rollback");
  const db = await seed(filename), repo = new SqliteSignalRepo(db);
  await repo.create(candidate);
  await repo.updateState(candidate.signal_id, "compiled");
  db.connection.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE OF signal_state ON signals
    WHEN NEW.signal_state='materialization_unknown' BEGIN SELECT RAISE(ABORT,'recovery rejected'); END`);
  db.close();
  try {
    await expect(openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined)).rejects.toThrow();
    const inspect = initDatabase({ filename });
    expect((await new SqliteSignalRepo(inspect).getById(candidate.signal_id))?.signal_state).toBe("compiled");
    expect(await new SqliteEventLogRepo(inspect).queryByEntity("candidate_memory_signal", candidate.signal_id)).toHaveLength(0);
    inspect.connection.exec("DROP TRIGGER reject_recovery");
    inspect.close();
    const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
    expect((await new SqliteSignalRepo(owner.database).getById(candidate.signal_id))?.signal_state).toBe("materialization_unknown");
    await closeOwner(owner);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("continues past malformed and hundreds of interrupted rows without reading ambiguous histories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-recovery-pages-"));
  const filename = join(directory, "alaya.db"), db = await seed(filename), repo = new SqliteSignalRepo(db);
  db.connection.transaction(() => {
    for (let index = 0; index < 502; index += 1) {
      const row = signal(`orphan-${String(index).padStart(4, "0")}`);
      repo.createInCurrentTransaction(row);
      repo.updateStateInCurrentTransaction(row.signal_id, "compiled");
    }
    const bad = signal("bad");
    repo.createInCurrentTransaction(bad);
    repo.updateStateInCurrentTransaction(bad.signal_id, "compiled");
    db.connection.prepare("UPDATE signals SET raw_payload_json='[]' WHERE signal_id=?").run(bad.signal_id);
  })();
  const events = new SqliteEventLogRepo(db);
  for (let i = 0; i < 600; i += 1) await events.append({ event_type: "soul.signal.materialized",
    entity_type: "candidate_memory_signal", entity_id: "orphan-0000", workspace_id: "workspace-1", run_id: "run-1",
    caused_by: "materialization_router", payload_json: { signal_id: "orphan-0000", workspace_id: "workspace-1",
      run_id: "run-1", success: true, created_objects: [] } });
  db.close();
  const warn = vi.fn(), owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), warn);
  try {
    expect((owner.database.connection.prepare("SELECT COUNT(*) AS n FROM signals WHERE signal_state='materialization_unknown'").get() as { n: number }).n).toBe(502);
    expect(warn).toHaveBeenCalledWith("Interrupted signal is unreadable; inspection required.", { signal_id: "bad" });
    expect((await new SqliteEventLogRepo(owner.database).queryByEntityAll("candidate_memory_signal", "orphan-0000"))).toHaveLength(601);
  } finally { await closeOwner(owner); rmSync(directory, { recursive: true, force: true }); }
});
