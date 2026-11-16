import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  DYNAMICS_CONSTANTS,
  GardenEventType,
  WorkspaceKind,
  WorkspaceState,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  createBulkEnrichReporter,
  runBulkEnrichTask
} from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";
import { buildMemory, buildSignal, bulkEnrichTask } from "./runtime-bulk-enrich-fixture.js";

const NOW = "2026-05-31T12:00:00.000Z";
const LATER = "2026-05-31T12:01:00.000Z";
const WORKSPACE = "workspace-1";

describe("bulk enrichment attempt accounting", () => {
  it("accounts for mixed item dispositions and resumes only unfinished independent work after reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-bulk-attempts-"));
    const filename = join(directory, "alaya.db");
    let database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({
        workspace_id: WORKSPACE,
        name: "Enrichment attempts",
        root_path: directory,
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        workspace_state: WorkspaceState.ACTIVE,
        default_engine_binding: null
      });
      let pending = new SqliteEnrichPendingRepo(database);
      for (const id of ["a-processed", "b-missing", "c-retry", "d-withheld", "e-abandoned"]) {
        pending.enqueue({ workspaceId: WORKSPACE, memoryId: id, runId: null,
          sourceSignalId: id === "d-withheld" ? "signal-held" : null, enqueuedAt: NOW });
      }
      for (let attempt = 1; attempt < DYNAMICS_CONSTANTS.enrich.max_attempts; attempt += 1) {
        pending.recordFailedAttempt(WORKSPACE, "e-abandoned", DYNAMICS_CONSTANTS.enrich.max_attempts, NOW);
      }
      const row = (id: string) => database.connection.prepare(
        "SELECT claimed_at, processed_at, independent_processed_at, attempt_count, abandoned_at, signal_ref_waiting FROM enrich_pending WHERE memory_id = ?"
      ).get(id);
      const trace: string[] = [];
      const completions: GardenTaskResult[] = [];
      let retryFails = true;
      const edgeProducer = { produceForNewMemory: vi.fn(async (input: { newMemoryId: string }) => {
        trace.push(`edge:${input.newMemoryId}`);
        if (input.newMemoryId === "e-abandoned" || (retryFails && input.newMemoryId === "c-retry")) {
          throw new Error(`edge failed:${input.newMemoryId}`, { cause: new Error("provider unavailable") });
        }
      }) };
      const conflictDetection = { detectAndLinkConflicts: vi.fn(async (input: { newMemoryId: string }) => {
        trace.push(`conflict:${input.newMemoryId}`);
        return { availability: "ok" as const };
      }) };
      const signalRefReplay = { replaySignalRefs: vi.fn(async () => {
        expect(row("d-withheld")).toMatchObject({ independent_processed_at: NOW, processed_at: null });
        trace.push("replay:d-withheld");
        return "withheld" as const;
      }) };
      function reporter() {
        const eventLogRepo = new SqliteEventLogRepo(database);
        return createBulkEnrichReporter({
          eventPublisher: new EventPublisher({
            eventLogRepo,
            runHotStateService: { apply: () => undefined },
            runtimeNotifier: {
              notify: () => undefined,
              notifyEntry: async (entry) => {
                expect(entry.event_type).toBe(GardenEventType.SOUL_ENRICH_ABANDONED);
                expect(await eventLogRepo.queryByEntity("memory", "e-abandoned")).toHaveLength(1);
                expect(row("e-abandoned")).toMatchObject({
                  abandoned_at: NOW, attempt_count: DYNAMICS_CONSTANTS.enrich.max_attempts
                });
                trace.push("notify:abandoned");
              }
            }
          }),
          gardenScheduler: { reportCompletion: async (result: GardenTaskResult) => {
            trace.push("completion");
            completions.push(result);
          } },
          warn: (_message, meta) => trace.push(`warn:${String(meta.memory_id)}`)
        });
      }
      const availability = () => ({ kind: "ready" as const, ports: {
        enrichPendingRepo: pending,
        memoryLookup: { findById: async (id: string) => id === "b-missing" ? null : buildMemory(id) },
        edgeProducer,
        conflictDetection,
        signalLookup: { getById: async (id: string) => buildSignal(id) },
        signalRefReplay
      } });
      const now = vi.fn(() => NOW);
      const claim = vi.spyOn(pending, "claimBatch");
      await runBulkEnrichTask({ now, task: bulkEnrichTask(), availability: availability(), reporter: reporter() });

      expect(now).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledWith(WORKSPACE, DYNAMICS_CONSTANTS.enrich.claim_batch_size,
        NOW, DYNAMICS_CONSTANTS.enrich.max_attempts, "materialized");
      expect(trace).toEqual([
        "edge:a-processed", "conflict:a-processed",
        "edge:c-retry", "warn:c-retry",
        "edge:d-withheld", "conflict:d-withheld", "replay:d-withheld",
        "edge:e-abandoned", "notify:abandoned", "warn:e-abandoned", "completion"
      ]);
      expect(completions[0]).toMatchObject({ outcome: "failed", success: false, completed_at: NOW,
        error_message: "bulk enrich batch has unfinished failed items",
        audit_entries: ["bulk_enrich:processed_1", "bulk_enrich:missing_1", "bulk_enrich:failed_2",
          "bulk_enrich:abandoned_1", "bulk_enrich:withheld_1"] });
      expect(row("a-processed")).toMatchObject({ processed_at: NOW, independent_processed_at: NOW, attempt_count: 0 });
      expect(row("b-missing")).toBeUndefined();
      expect(row("c-retry")).toMatchObject({ claimed_at: null, processed_at: null,
        independent_processed_at: null, attempt_count: 1, abandoned_at: null });
      expect(row("d-withheld")).toMatchObject({ claimed_at: null, processed_at: null,
        independent_processed_at: NOW, attempt_count: 0, signal_ref_waiting: 1 });
      const abandon = (await new SqliteEventLogRepo(database).queryByEntity("memory", "e-abandoned"))[0];
      expect(abandon?.payload_json).toMatchObject({
        attempt_count: DYNAMICS_CONSTANTS.enrich.max_attempts, last_failure_kind: "edge failed:e-abandoned"
      });

      database.close();
      database = initDatabase({ filename });
      pending = new SqliteEnrichPendingRepo(database);
      retryFails = false;
      trace.length = 0;
      await runBulkEnrichTask({ now: () => LATER, task: bulkEnrichTask(),
        availability: availability(), reporter: reporter() });

      expect(trace).toEqual(["edge:c-retry", "conflict:c-retry", "completion"]);
      expect(row("c-retry")).toMatchObject({ processed_at: LATER, independent_processed_at: LATER, attempt_count: 1 });
      expect(completions[1]).toMatchObject({ outcome: "completed", success: true, error_message: null,
        audit_entries: ["bulk_enrich:processed_1", "bulk_enrich:missing_0", "bulk_enrich:failed_0",
          "bulk_enrich:abandoned_0", "bulk_enrich:withheld_0"] });
      expect(pending.countPending(WORKSPACE)).toBe(2);
      expect(signalRefReplay.replaySignalRefs).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { outcome: "uncertain", ownsCompletion: false, completion: false },
    { outcome: "busy", ownsCompletion: false, completion: false },
    { outcome: "work_busy", ownsCompletion: false, completion: false },
    { outcome: "completed", ownsCompletion: true, completion: false },
    { outcome: "failed", ownsCompletion: true, completion: false },
    { outcome: "missing", ownsCompletion: true, completion: true },
    { outcome: "completed", ownsCompletion: false, completion: true },
    { outcome: "failed", ownsCompletion: false, completion: true }
  ])("leaves source completion ownership intact for $outcome (owned=$ownsCompletion)", async ({ outcome, ownsCompletion, completion }) => {
    const now = vi.fn(() => NOW);
    const reportCompletion = vi.fn(async () => undefined);
    const task = { ...bulkEnrichTask(), source_object_id: "source-1", enrichment_contract: "source_enrichment.v1" };
    await runBulkEnrichTask({
      now,
      task,
      availability: { kind: "missing_repo" },
      reporter: { reportCompletion, emitEnrichAbandoned: vi.fn(), warn: vi.fn() },
      sourceEnrichment: { run: async () => outcome, ownsCompletion }
    });
    expect(now).toHaveBeenCalledTimes(1);
    expect(reportCompletion).toHaveBeenCalledTimes(completion ? 1 : 0);
    if (completion) {
      expect(reportCompletion).toHaveBeenCalledWith(task, NOW, outcome === "completed" ? "completed" : "failed",
        [`source_enrich:${outcome}`], outcome === "completed" ? undefined : expect.objectContaining({ message: outcome }));
    }
  });

  it("passes the original source failure and cause to completion before warning", async () => {
    const cause = new Error("transport stopped");
    const failure = new Error("source failed", { cause });
    const trace: string[] = [];
    const reportCompletion = vi.fn(async () => { trace.push("completion"); });
    await runBulkEnrichTask({
      now: () => NOW,
      task: { ...bulkEnrichTask(), source_object_id: "source-1", enrichment_contract: "source_enrichment.v1" },
      availability: { kind: "disabled" },
      reporter: { reportCompletion, emitEnrichAbandoned: vi.fn(), warn: () => { trace.push("warn"); } },
      sourceEnrichment: { run: async () => { throw failure; }, ownsCompletion: true }
    });
    expect(reportCompletion).toHaveBeenCalledWith(expect.any(Object), NOW, "failed", [], failure);
    expect(failure.cause).toBe(cause);
    expect(trace).toEqual(["completion", "warn"]);
  });
});
