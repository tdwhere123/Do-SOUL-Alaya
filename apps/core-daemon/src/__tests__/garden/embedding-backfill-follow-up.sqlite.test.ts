import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { GardenScheduler } from "@do-soul/alaya-soul";
import { EventPublisher } from "@do-soul/alaya-core";
import { getSqliteWriteQueuePort, initDatabase, SqliteEventLogRepo, SqliteGardenTaskRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { EmbeddingBackfillCheckpoint } from "../../garden/scheduler/embedding-backfill-checkpoint.js";
import { createEmbeddingBackfillRuntimeSupport } from "../../garden/scheduler/scheduler-runtime-embedding-backfill.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler/scheduler-runtime-types.js";
import { closeDaemonSqliteWriteQueue } from "../../runtime/startup/database.js";
import { openRuntimeDatabase } from "../../runtime/startup/runtime-database.js";
import { CLOCK, createFaults, createHandoffRuntime, EVIDENCE, IDS, notifier, OTHER_WORKSPACE, seedAdditionalHandoffData, seedHandoffData, WORKSPACE,
  type HandoffFaults } from "./embedding-backfill-follow-up-fixture.js";

const directories = new Set<string>();
afterEach(() => {
  // A runtime writer owns a separate SQLite connection, not database.connection.
  expect(getSqliteWriteQueuePort()).toBeNull();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

function filename(): string {
  const directory = mkdtempSync(join(tmpdir(), "alaya-garden-follow-up-"));
  directories.add(directory);
  return join(directory, "alaya.db");
}

function checkpoint(database: StorageDatabase) {
  return database.connection.prepare(`SELECT r.task_id, r.state, r.mode, r.plan_digest, r.attempt_count,
    r.last_error, t.status, t.outcome FROM garden_embedding_backfill_runs r JOIN garden_tasks t ON t.id = r.task_id`)
    .get() as { task_id: string; state: string; mode: string; plan_digest: string | null; attempt_count: number;
      last_error: string | null; status: string; outcome: string | null };
}

function count(database: StorageDatabase, table: string): number {
  return (database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function reopened(file: string, faults: HandoffFaults) {
  const opened = await openRuntimeDatabase(file, notifier, () => undefined);
  try {
    return { ...opened, ...createHandoffRuntime(opened.database, faults) };
  } catch (error) {
    await closeReopenedRuntime(opened);
    throw error;
  }
}

async function closeReopenedRuntime(opened: Awaited<ReturnType<typeof openRuntimeDatabase>>): Promise<void> {
  // Drain and retire the worker before closing the caller connection or releasing
  // the runtime lease. Otherwise Windows cannot remove the worker's database.
  try { await closeDaemonSqliteWriteQueue(); }
  finally {
    try { opened.database.close(); }
    finally { await opened.temporalRuntimeLease.release(); }
  }
}

async function killAt(file: string, point: "task_dispatch" | "before_embedding" | "embedding" | "assertion" | "followup_audit" | "task_audit" | "retry_claim") {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const config = fileURLToPath(new URL("./support/embedding-kill.vitest.config.mjs", import.meta.url));
  const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config], {
    cwd: root, env: { ...process.env, ALAYA_GARDEN_CRASH_DATABASE: file, ALAYA_GARDEN_CRASH_POINT: point },
    stdio: ["ignore", "pipe", "pipe"], timeout: 45_000, killSignal: "SIGKILL"
  });
  let output = "";
  let reachedCheckpoint = false;
  child.stdout.on("data", chunk => {
    output += String(chunk);
    if (!reachedCheckpoint && output.includes(`ALAYA_GARDEN_CRASH_POINT_REACHED:${point}\n`)) {
      reachedCheckpoint = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  expect(reachedCheckpoint, output).toBe(true);
  expect(exit.signal, output).toBe("SIGKILL");
}

describe("embedding backfill supported follow-up recovery", () => {
  it.each([false, true])("retires the runtime writer and lease after a backfill with provider failure=%s", async failEmbedding => {
    const file = filename();
    const initial = initDatabase({ filename: file });
    try { await seedHandoffData(initial); } finally { initial.close(); }
    const opened = await reopened(file, createFaults());
    const queue = getSqliteWriteQueuePort();
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    try {
      expect(queue).not.toBeNull();
      // This payload opens the worker's independent native SQLite handle even
      // when the provider fails before the backfill can write any vectors.
      await queue!.enqueue({ jobId: "fixture-writer-handle", kind: "maintenance", filename: file,
        payload: { statements: [{ sql: "CREATE TABLE fixture_writer_handle (id INTEGER)" }] } });
      const faults = createFaults();
      faults.failEmbedding = failEmbedding;
      const harness = createHandoffRuntime(opened.database, faults);
      const execution = harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      if (failEmbedding) await expect(execution).rejects.toThrow(/embedding_failed:provider/);
      else await execution;
    } finally {
      try {
        await closeReopenedRuntime(opened);
        expect(terminate).toHaveBeenCalledTimes(1);
        const worker = terminate.mock.contexts[0];
        expect(worker).toBeInstanceOf(Worker);
        if (worker instanceof Worker) expect(worker.threadId).toBe(-1);
      } finally { terminate.mockRestore(); }
    }
    expect(opened.database.isClosed()).toBe(true);
    expect(getSqliteWriteQueuePort()).toBeNull();
    await expect(queue!.enqueue({ jobId: "retired-writer", kind: "maintenance", filename: file,
      payload: { statements: [] } })).rejects.toThrow(/clos/i);
    // Delete immediately, with no retries: Windows rejects an outstanding native
    // database/lease handle; POSIX alone would allow unlinking an open file.
    rmSync(dirname(file), { recursive: true });
    expect(existsSync(dirname(file))).toBe(false);
    directories.delete(dirname(file));
    const next = initDatabase({ filename: filename() });
    try {
      await seedHandoffData(next);
      expect(count(next, "memory_entries")).toBe(3);
      expect(getSqliteWriteQueuePort()).toBeNull();
      expect(existsSync(dirname(file))).toBe(false);
    } finally { next.close(); }
  });

  it("retries formation after the daemon's combined memory and evidence backfills without repeating either", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      database.connection.prepare(`UPDATE evidence_capsules SET created_by = 'garden_compile', source_hash = ?,
        physical_anchor = ? WHERE workspace_id = ?`).run(`sha256:garden-source-turn-fallback-v2:${"a".repeat(64)}`,
        JSON.stringify({ file_path: null, line_range: null, symbol_name: null,
          artifact_ref: "alaya:garden-turn-evidence:signal-1" }), WORKSPACE);
      const harness = createHandoffRuntime(database, faults, false, false, false, true);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      expect(count(database, "memory_embeddings")).toBe(3);
      expect(count(database, "evidence_recall_embeddings")).toBe(3);
      expect(count(database, "relation_assertions")).toBe(1);
      expect(faults.embedCalls).toBe(2);
    } finally { database.close(); }
    faults.failAdmissionAt = null;
    const opened = await openRuntimeDatabase(file, notifier, () => undefined);
    try {
      const resumed = createHandoffRuntime(opened.database, faults, false, false, false, true);
      await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(count(opened.database, "memory_embeddings")).toBe(3);
      expect(count(opened.database, "evidence_recall_embeddings")).toBe(3);
      expect(count(opened.database, "relation_assertions")).toBe(3);
      expect((await resumed.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
      expect(checkpoint(opened.database)).toMatchObject({ state: "completed", status: "failed", outcome: "failed" });
      expect(faults.embedCalls).toBe(2);
    } finally { await closeReopenedRuntime(opened); }
  });

  it("preserves committed vectors and retries a partially admitted plan after reopen without duplicate assertions", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const first = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      expect(count(database, "memory_embeddings")).toBe(3);
      expect(count(database, "garden_embedding_backfill_objects")).toBe(3);
      expect(count(database, "relation_assertions")).toBe(1);
      expect(checkpoint(database)).toMatchObject({ state: "pending", status: "failed", outcome: "failed", attempt_count: 1 });
      const plan = checkpoint(database).plan_digest;
      expect(plan).toMatch(/^[0-9a-f]{64}$/);
      const completion = (await first.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events.at(-1);
      expect(completion?.payload_json).toMatchObject({ success: false, outcome: "failed" });
      expect(faults.embedCalls).toBe(1);
      database.close();

      faults.failAdmissionAt = null;
      const resumed = await reopened(file, faults);
      try {
        await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
        expect(faults.embedCalls).toBe(1);
        expect(count(resumed.database, "memory_embeddings")).toBe(3);
        expect(count(resumed.database, "relation_assertions")).toBe(3);
        expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "failed",
          outcome: "failed", plan_digest: plan, attempt_count: 2 });
        const events = (await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events;
        expect(events.map(event => event.payload_json.disposition)).toEqual(["pending", "retryable_failure", "claimed", "completed"]);
        const admissions = (await resumed.eventLog.queryByType("relation.assertion_admitted")).events;
        expect(admissions).toHaveLength(3);
      } finally { await closeReopenedRuntime(resumed); }
    } finally { if (!database.isClosed()) database.close(); }
  });

  it("reconciles an assertion committed before an exception instead of duplicating it", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const first = createHandoffRuntime(database, faults);
      faults.failAfterAdmissionAt = 1;
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      expect(count(database, "relation_assertions")).toBe(1);
      expect(checkpoint(database).state).toBe("pending");
      database.close();
      faults.failAfterAdmissionAt = null;
      const resumed = await reopened(file, faults);
      try {
        await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
        expect(count(resumed.database, "relation_assertions")).toBe(3);
        expect((await resumed.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
        expect(faults.embedCalls).toBe(1);
      } finally { await closeReopenedRuntime(resumed); }
    } finally { if (!database.isClosed()) database.close(); }
  });

  it.each(["task_dispatch", "before_embedding"] as const)(
    "recovers a process killed at %s before any vector commits", async point => {
      const file = filename();
      const initial = initDatabase({ filename: file });
      await seedHandoffData(initial);
      initial.close();
      await killAt(file, point);
      const faults = createFaults();
      const resumed = await reopened(file, faults);
      try {
        expect(count(resumed.database, "memory_embeddings")).toBe(0);
        expect(count(resumed.database, "garden_embedding_backfill_objects")).toBe(0);
        expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toHaveLength(0);
        await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
        expect(count(resumed.database, "memory_embeddings")).toBe(3);
        expect(count(resumed.database, "relation_assertions")).toBe(3);
        expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "completed", outcome: "completed" });
      } finally { await closeReopenedRuntime(resumed); }
    }, 60_000
  );

  it("recovers a process killed immediately after a committed embedding", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    await seedHandoffData(database);
    database.close();
    await killAt(file, "embedding");
    const faults = createFaults();
    faults.embeddedTexts = [];
    const resumed = await reopened(file, faults);
    try {
      expect(checkpoint(resumed.database)).toMatchObject({ state: "backfilling", status: "pending", outcome: null });
      expect(count(resumed.database, "memory_embeddings")).toBe(1);
      expect(count(resumed.database, "garden_embedding_backfill_objects")).toBe(1);
      await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(faults.embeddedTexts).toHaveLength(1);
      expect(faults.embeddedTexts?.[0]).toHaveLength(2);
      expect(faults.embeddedTexts?.[0]).not.toContain("Memory 0 about cobalt deployment policy.");
      expect(count(resumed.database, "relation_assertions")).toBe(3);
      expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "completed", outcome: "completed" });
    } finally { await closeReopenedRuntime(resumed); }
  }, 60_000);

  it.each(["assertion", "followup_audit", "task_audit"] as const)(
    "recovers a process killed after the %s commit without duplicate effects or audits", async point => {
      const file = filename();
      const initial = initDatabase({ filename: file });
      await seedHandoffData(initial);
      initial.close();
      await killAt(file, point);
      const faults = createFaults();
      const resumed = await reopened(file, faults);
      try {
        expect(count(resumed.database, "memory_embeddings")).toBe(3);
        if (point === "assertion") expect(count(resumed.database, "relation_assertions")).toBe(1);
        else expect(count(resumed.database, "relation_assertions")).toBe(3);
        if (point !== "task_audit") await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
        expect(faults.embedCalls).toBe(0);
        expect(count(resumed.database, "relation_assertions")).toBe(3);
        expect((await resumed.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
        expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
          .map(event => event.payload_json.disposition)).toEqual(point === "assertion"
            ? ["pending", "recovered", "completed"] : ["pending", "completed", "recovered"]);
        expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toHaveLength(1);
        expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "completed", outcome: "completed" });
      } finally { await closeReopenedRuntime(resumed); }
    }, 60_000
  );

  it("fails explicitly when embedding is unavailable before any vector commits", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      faults.failEmbedding = true;
      const harness = createHandoffRuntime(database, faults);
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/embedding_failed:provider/);
      expect(count(database, "memory_embeddings")).toBe(0);
      expect(count(database, "garden_embedding_backfill_objects")).toBe(0);
      expect(count(database, "relation_assertions")).toBe(0);
      expect(checkpoint(database)).toMatchObject({ state: "skipped", status: "failed", outcome: "failed" });
      const event = (await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events.at(-1);
      expect(event?.payload_json).toMatchObject({ success: false, outcome: "failed" });
    } finally { database.close(); }
  });

  it("reopens after vector commits but before handoff without re-embedding committed memories", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const first = createHandoffRuntime(database, faults);
      database.connection.exec(`CREATE TRIGGER fail_backfill_handoff BEFORE UPDATE OF state ON garden_embedding_backfill_runs
        WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'handoff interrupted'); END`);
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/handoff interrupted/);
      expect(checkpoint(database)).toMatchObject({ state: "backfilling", status: "pending", outcome: null });
      expect(count(database, "memory_embeddings")).toBe(3);
      expect(count(database, "garden_embedding_backfill_objects")).toBe(3);
      expect(count(database, "relation_assertions")).toBe(0);
      database.close();
      const resumed = await reopened(file, faults);
      try {
        resumed.database.connection.exec("DROP TRIGGER fail_backfill_handoff");
        expect(checkpoint(resumed.database)).toMatchObject({ state: "backfilling", status: "pending" });
        await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
        expect(faults.embedCalls).toBe(1);
        expect(count(resumed.database, "relation_assertions")).toBe(3);
        expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "completed", outcome: "completed" });
        expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)).events).toHaveLength(0);
        expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
          .filter(event => event.caused_by === "garden-settled-attempt-recovery")).toHaveLength(1);
      } finally { await closeReopenedRuntime(resumed); }
    } finally { if (!database.isClosed()) database.close(); }
  });

  it("reconciles committed assertions when follow-up completion audit fails", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failFollowUpAudit = true;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/completion_unavailable/);
      expect(count(database, "relation_assertions")).toBe(3);
      expect(checkpoint(database)).toMatchObject({ state: "pending", status: "failed", outcome: "failed", attempt_count: 0 });
      await harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(count(database, "relation_assertions")).toBe(3);
      expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
      expect(checkpoint(database)).toMatchObject({ state: "completed", attempt_count: 1 });
      expect(faults.embedCalls).toBe(1);
    } finally { database.close(); }
  });

  it("leaves repeat failures retryable and blocks a changed HQ plan without admitting a new identity", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const first = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      const originalPlan = checkpoint(database).plan_digest;
      faults.failAdmissionAt = 3;
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      expect(checkpoint(database)).toMatchObject({ state: "pending", attempt_count: 2, plan_digest: originalPlan });
      expect(count(database, "relation_assertions")).toBe(1);
      faults.failAdmissionAt = null;
      await first.hq.upsertFromEvidence({ object_id: IDS[1], workspace_id: WORKSPACE,
        hqs: ["replacement unrelated project language"], evidence_id: EVIDENCE[1], producer_id: "fixture_hq_changed",
        created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:01.000Z" });
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/formation_changed/);
      expect(checkpoint(database)).toMatchObject({ state: "blocked", last_error: "formation_changed", plan_digest: originalPlan });
      expect(count(database, "relation_assertions")).toBe(1);
      await expect(first.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/inspection is required/);
      expect(faults.embedCalls).toBe(1);
    } finally { database.close(); }
  });

  it("rechecks the frozen HQ inputs inside each governed admission transaction", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      let unblock: () => void = () => undefined;
      let announce: () => void = () => undefined;
      const started = new Promise<void>(resolve => { announce = resolve; });
      faults.pauseUntil = new Promise<void>(resolve => { unblock = resolve; });
      faults.pauseStarted = announce;
      faults.pauseAdmissionAt = 2;
      const execution = harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      await started;
      await harness.hq.upsertFromEvidence({ object_id: IDS[1], workspace_id: WORKSPACE,
        hqs: ["changed after first assertion"], evidence_id: EVIDENCE[1], producer_id: "fixture_hq_changed",
        created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:01.000Z" });
      unblock();
      await expect(execution).rejects.toThrow(/source_unavailable/);
      expect(count(database, "relation_assertions")).toBe(1);
      expect(checkpoint(database)).toMatchObject({ state: "blocked", outcome: "failed" });
      expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(1);
    } finally { database.close(); }
  });

  it("continues an independent pending follow-up when another retry fails", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      await seedAdditionalHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      const firstId = checkpoint(database).task_id;
      const repo = new SqliteGardenTaskRepo(database.connection, harness.publisher);
      const scheduler = new GardenScheduler({ append: async () => undefined }, { now: () => CLOCK }, null, repo);
      const task: GardenTaskDescriptor = { task_id: "zz-independent-backfill", task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        required_tier: GardenTier.TIER_2, workspace_id: OTHER_WORKSPACE, run_id: null, target_object_refs: [OTHER_WORKSPACE],
        priority: 10, created_at: CLOCK };
      scheduler.enqueue(task);
      expect((await scheduler.dispatchNext(GardenRole.LIBRARIAN))?.task_id).toBe(task.task_id);
      const support = createEmbeddingBackfillRuntimeSupport({ now: () => CLOCK, gardenScheduler: scheduler,
        embeddingBackfillHandler: harness.handler, answersWithEdgeProducerPort: harness.answersPort,
        embeddingBackfillCheckpoint: new EmbeddingBackfillCheckpoint(database.connection, harness.publisher, () => CLOCK),
        warn: () => undefined } as unknown as CreateGardenSchedulerRuntimeSupportInput);
      faults.failAdmissionAt = faults.admitCalls + 2;
      expect((await support.runEmbeddingBackfillTask(task)).outcome).toBe("failed");
      faults.failAdmissionAt = faults.admitCalls + 1;
      const services = (harness.runtime.backgroundManager as unknown as {
        services: readonly { name: string; task(): Promise<void> }[];
      }).services;
      const scheduled = services.find(service => service.name === "GardenScheduler")!;
      await scheduled.task();
      faults.failAdmissionAt = null;
      await scheduled.task();
      const rows = database.connection.prepare(`SELECT task_id, state FROM garden_embedding_backfill_runs ORDER BY task_id`)
        .all() as { task_id: string; state: string }[];
      expect(rows).toContainEqual({ task_id: firstId, state: "pending" });
      expect(rows).toContainEqual({ task_id: task.task_id, state: "completed" });
      expect(count(database, "relation_assertions")).toBe(4);
      expect(faults.embedCalls).toBe(2);
    } finally { database.close(); }
  });

  it("the scheduled Garden pass retries the owed follow-up without dispatching another backfill", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      faults.failAdmissionAt = null;
      const services = (harness.runtime.backgroundManager as unknown as {
        services: readonly { name: string; task(): Promise<void> }[];
      }).services;
      const scheduler = services.find(service => service.name === "GardenScheduler");
      expect(scheduler).toBeDefined();
      await scheduler!.task();
      expect(checkpoint(database)).toMatchObject({ state: "completed", status: "failed", attempt_count: 2 });
      expect(count(database, "relation_assertions")).toBe(3);
      expect(faults.embedCalls).toBe(1);
      expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual(["pending", "retryable_failure", "claimed", "completed"]);
    } finally { database.close(); }
  });

  it("preserves an unmeasured external backfill result as unknown rather than performed work", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults, false, false, true);
      await harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(checkpoint(database)).toMatchObject({ state: "skipped", status: "completed", outcome: null });
      const event = (await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events.at(-1);
      expect(event?.payload_json.success).toBe(true);
      expect(event?.payload_json).not.toHaveProperty("outcome");
      expect(count(database, "memory_embeddings")).toBe(0);
      expect(count(database, "relation_assertions")).toBe(0);
    } finally { database.close(); }
  });

  it("does not expose an unaudited pending handoff when its audit append fails", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failPendingAudit = true;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/pending audit failure/);
      expect(checkpoint(database)).toMatchObject({ state: "backfilling", status: "pending", outcome: null });
      expect(count(database, "memory_embeddings")).toBe(3);
      expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual(["recovered"]);
    } finally { database.close(); }
    const resumed = await reopened(file, faults);
    try {
      await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "completed", outcome: "completed" });
      expect(faults.embedCalls).toBe(1);
      expect(count(resumed.database, "relation_assertions")).toBe(3);
      expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual(["recovered", "pending", "completed"]);
    } finally { await closeReopenedRuntime(resumed); }
  });

  it("keeps an unwired formation retryable and completes it once the producer is restored", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const unwired = createHandoffRuntime(database, faults, false, true);
      await expect(unwired.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed:unwired/);
      expect(checkpoint(database)).toMatchObject({ state: "pending", mode: "unwired", status: "failed",
        last_error: "unwired", attempt_count: 1 });
      expect(count(database, "relation_assertions")).toBe(0);
    } finally { database.close(); }
    const resumed = await reopened(file, faults);
    try {
      await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", mode: "unwired",
        status: "failed", attempt_count: 2 });
      expect(count(resumed.database, "relation_assertions")).toBe(3);
      expect(faults.embedCalls).toBe(1);
    } finally { await closeReopenedRuntime(resumed); }
  });

  it("audits retry ownership before claim and recovers a killed retry owner", async () => {
    const file = filename();
    const database = initDatabase({ filename: file });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      faults.failAdmissionAt = null;
      faults.failRetryClaimAudit = true;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/claim audit failure/);
      expect(database.connection.prepare("SELECT owner_token FROM garden_embedding_backfill_runs").get()).toEqual({ owner_token: null });
      expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual(["pending", "retryable_failure"]);
    } finally { database.close(); }
    await killAt(file, "retry_claim");
    const resumed = await reopened(file, faults);
    try {
      expect(database.isClosed()).toBe(true);
      expect(resumed.database.connection.prepare("SELECT owner_token FROM garden_embedding_backfill_runs").get())
        .toEqual({ owner_token: null });
      await resumed.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(checkpoint(resumed.database)).toMatchObject({ state: "completed", status: "failed", attempt_count: 2 });
      expect(count(resumed.database, "relation_assertions")).toBe(3);
      expect(faults.embedCalls).toBe(1);
      expect((await resumed.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual([
          "pending", "retryable_failure", "claimed", "recovered", "claimed", "completed"
        ]);
    } finally { await closeReopenedRuntime(resumed); }
  }, 60_000);

  it("atomically chooses one retry claimant across independent SQLite connections", async () => {
    const file = filename();
    const first = initDatabase({ filename: file });
    const faults = createFaults();
    let second: StorageDatabase | undefined;
    try {
      await seedHandoffData(first);
      const harness = createHandoffRuntime(first, faults);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      faults.failAdmissionAt = null;
      second = initDatabase({ filename: file });
      const publisher = new EventPublisher({ eventLogRepo: new SqliteEventLogRepo(second),
        runHotStateService: { apply: () => undefined }, runtimeNotifier: notifier });
      const candidates = [new EmbeddingBackfillCheckpoint(first.connection, harness.publisher, () => CLOCK),
        new EmbeddingBackfillCheckpoint(second.connection, publisher, () => CLOCK)];
      const claims = await Promise.all(candidates.map(candidate => candidate.claimPending(WORKSPACE)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = claims.findIndex(Boolean);
      expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
        .map(event => event.payload_json.disposition)).toEqual(["pending", "retryable_failure", "claimed"]);
      candidates[winner]!.release(claims[winner]!);
      await harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(count(first, "relation_assertions")).toBe(3);
      expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
      expect(faults.embedCalls).toBe(1);
    } finally { second?.close(); first.close(); }
  });

  it("admits only one concurrent retry owner while the first is in flight", async () => {
    const database = initDatabase({ filename: filename() });
    const faults = createFaults();
    try {
      await seedHandoffData(database);
      const harness = createHandoffRuntime(database, faults);
      faults.failAdmissionAt = 2;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
      faults.failAdmissionAt = null;
      let unblock: () => void = () => undefined;
      let announce: () => void = () => undefined;
      const started = new Promise<void>(resolve => { announce = resolve; });
      faults.pauseUntil = new Promise<void>(resolve => { unblock = resolve; });
      faults.pauseStarted = announce;
      faults.pauseAdmissionAt = 3;
      const retry = harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      await started;
      await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/already owned/);
      unblock();
      await retry;
      expect(count(database, "relation_assertions")).toBe(3);
      expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
      expect(checkpoint(database).attempt_count).toBe(2);
      expect(faults.embedCalls).toBe(1);
    } finally { database.close(); }
  });
});
