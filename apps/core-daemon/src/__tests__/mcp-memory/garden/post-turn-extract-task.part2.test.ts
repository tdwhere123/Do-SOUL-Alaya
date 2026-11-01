import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  SignalSource,
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader
} from "@do-soul/alaya-storage";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../../garden/support/task-signal-id.js";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";
import { readRetainedPostTurnSource, recordedSessionResponses } from "./post-turn-source-fixture.js";

import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

import {
  cleanupPostTurnExtractHarnesses,
  createMcpDeps,
  createDeliveryRecord,
  createHandlerHarness,
  createPostTurnPayload,
  createRoutingHarness,
  recordedStatementExtract,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
  pageWorkspaceSourceRoots,
  postTurnRows,
  recall,
  reportUsage,
  seedRun,
  sessionRunContext,
  unwrapOk,
  type GardenListPendingTasksOutput,
  type PostTurnPayload
} from "./post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn extract Garden task", () => {
  it("processes post-turn and session work behind more than fifty unrelated librarian tasks", async () => {
    const extract = recordedStatementExtract(message => message.role === "user" ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : []);
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    for (let index = 0; index < 51; index += 1) {
      harness.gardenTaskRepo.enqueue({ id: `unrelated-${index}`, workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN, kind: GardenTaskKind.EDGE_CLASSIFY,
        payload: { task_id: `unrelated-${index}`, task_kind: GardenTaskKind.EDGE_CLASSIFY, required_tier: GardenTier.TIER_2,
          workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [`edge-${index}`], priority: 20,
          created_at: "2026-05-07T00:00:00.000Z" },
        created_at: "2026-05-07T00:00:00.000Z" });
    }
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 64, GardenTaskKind.EDGE_CLASSIFY)).toHaveLength(51);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.not.toBeNull();
  });

  it("retains the admitted original when the session model returns no statements", async () => {
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: recordedStatementExtract() });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(await harness.signalService.listByRun("run-1")).toHaveLength(0);
    expect(readRetainedPostTurnSource(harness.database, "post-turn-task-1")?.source_body)
      .toContain("I prefer pnpm commands in this repo.");
  });

  it("publishes session statements without a synthetic evidence fallback for the post-turn task", async () => {
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1");
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localExtract: recordedStatementExtract(message => message.role === "user" ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : []),
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed" });
    await expect(harness.signalRepo.getById(fallbackId)).resolves.toBeNull();
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.not.toBeNull();
    expect(readRetainedPostTurnSource(harness.database, "post-turn-task-1")?.source_body)
      .toContain("I prefer pnpm commands in this repo.");
  });

  it("completes post-turn work from retained evidence without synthetic evidence claims", async () => {
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      hasCreatedEvidence: async () => false
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed"
    });
    expect(readRetainedPostTurnSource(harness.database, "post-turn-task-1")?.source_body)
      .toContain("I prefer pnpm commands in this repo.");
    expect(await harness.signalService.listByRun("run-1")).toEqual([]);
  });

  it("host_worker routing falls back to the local provider after an unclaimed session chunk waits out the window", async () => {
    const officialExtract = recordedStatementExtract();
    const localExtract = recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]);
    const harness = await createRoutingHarness({ provider_kind: "host_worker", officialExtract, localExtract });
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(localExtract).not.toHaveBeenCalled();

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(officialExtract).not.toHaveBeenCalled();
    expect(localExtract).toHaveBeenCalledTimes(1);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toMatchObject({
      workspace_id: "workspace-1"
    });
  });

  it("local_heuristics routing settles an idle session chunk inline", async () => {
    const localExtract = recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]);
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(localExtract).toHaveBeenCalledTimes(1);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 1))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId(session!.id, 1)
    });
  });

  it("local_heuristics routing persists session signals for canonical attached session runs", async () => {
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics",
      localExtract: recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]) });
    await seedRun(harness.runRepo, "mcp-session-run-1");
    harness.enqueuePostTurnTask({
      id: "post-turn-session-task",
      payload: createPostTurnPayload({
        task_id: "post-turn-session-task",
        run_id: "mcp-session-run-1"
      })
    });

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-session-task")).toMatchObject({ status: "completed" });
    const [session] = harness.sessionTasks();
    expect(session?.payload).toMatchObject({ run_id: "mcp-session-run-1", session_id: "mcp-session-run-1" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toMatchObject({
      run_id: "mcp-session-run-1"
    });
  });

  it("a failing statement provider fails the session chunk without aborting the background pass", async () => {
    const extract = vi.fn<NonNullable<GardenComputeProvider["extractSourceStatementRequest"]>>(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract: extract });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await expect(harness.runScheduler()).resolves.toBeUndefined();

    expect(extract).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    })]);
    const completedEvents = (await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    )).events;
    expect(completedEvents.at(-1)?.payload_json).toMatchObject({
      task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      success: false,
      candidate_signals_count: 0
    });
    await expect(harness.signalRepo.getById(
      buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1")
    )).resolves.toBeNull();
    const roots = new SqliteSourceRootRecallReader(
      new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256),
      new SqliteEvidenceCapsuleRepo(harness.database)
    ).page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null });
    expect(roots.rows.some((row) =>
      row.kind === "source_record"
      && (row.content ?? "").includes("I prefer pnpm commands")
    )).toBe(true);
  });

  it("enqueue of a turn longer than 800 chars keeps the unsliced root after a throwing provider", async () => {
    const tail = "BEYOND_EIGHT_HUNDRED_MARKER";
    const excerpt = `${"a".repeat(800)}${tail}`;
    const extract = vi.fn<NonNullable<GardenComputeProvider["extractSourceStatementRequest"]>>(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract: extract });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));

    expect((await reportUsage(handler, {
      turn_index: 21,
      last_messages: [{ role: "user", content_excerpt: excerpt }]
    })).ok).toBe(true);

    const enqueued = postTurnRows(harness.gardenTaskRepo);
    expect(enqueued).toHaveLength(1);
    const taskId = enqueued[0]!.id;
    const payload = enqueued[0]!.payload as PostTurnPayload;
    expect(payload.turn_digest.last_messages[0]!.content_excerpt).toBe(excerpt);
    expect(payload.admitted_source_root_id).toMatch(/^sha256:[0-9a-f]{64}$/u);

    await expect(harness.runScheduler()).resolves.toBeUndefined();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await expect(harness.runScheduler()).resolves.toBeUndefined();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].messages[0]!.text).toBe(excerpt);
    expect(harness.gardenTaskRepo.findById(taskId)).toMatchObject({ status: "completed" });
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    })]);

    const roots = pageWorkspaceSourceRoots(harness.database);
    expect(roots.rows.some((row) =>
      row.kind === "source_record"
      && row.original_complete === false
      && row.content_complete === true
      && (row.content ?? "").includes(tail)
      && (row.content ?? "").length > 800
    )).toBe(true);
    expect(roots.rows.some((row) =>
      row.content_complete === true
      && (row.content ?? "").length > 0
      && !(row.content ?? "").includes(tail)
    )).toBe(false);
    expect(
      (harness.database.connection.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
        count: number;
      }).count
    ).toBe(0);
  });

  it("host_worker claim and completion bind session statement responses to the retained host messages", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "pending", claimed_by: null });

    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const claimResult = unwrapOk<{ readonly status: string; readonly payload: unknown }>(
      await handler.call({
        toolName: "garden.claim_task",
        arguments: { task_id: session!.id },
        context: defaultContext()
      })
    );
    expect(claimResult.status).toBe("claimed");
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({
      status: "claimed",
      claimed_by: defaultContext().agentTarget
    });

    const completeResult = unwrapOk<{ readonly status: string }>(
      await handler.call({
        toolName: "garden.complete_task",
        arguments: {
          task_id: session!.id,
          status: "completed",
          result_envelope: {
            source_statement_responses: recordedSessionResponses(claimResult.payload, message => message.role === "user"
              ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : [])
          }
        },
        context: defaultContext()
      })
    );
    expect(completeResult.status).toBe("completed");
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({ status: "completed" });
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: SignalSource.GARDEN_COMPILE, signal_state: "triaged",
      interpretation_contract: "source-statements-v1", object_kind: null, confidence: null,
      source_memory_refs: [], incompatible_with_refs: [],
      raw_payload: { source_statement: {
        source_root_id: readRetainedPostTurnSource(harness.database, "post-turn-task-1")?.record_id,
        message: { message_id: "post-turn:post-turn-task-1:message:0", role: "user" },
        statement: { text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" } } } });
    expect(readRetainedPostTurnSource(harness.database, "post-turn-task-1")?.source_body)
      .toContain("I prefer pnpm commands in this repo.");
  });

  it("preserves explicit graph refs on non-extraction tasks without promoting raw-payload arrays", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.gardenTaskRepo.enqueue({ id: "post-turn-task-1", workspace_id: "workspace-1",
      role: GardenRole.JANITOR, kind: GardenTaskKind.TTL_CLEANUP, created_at: "2026-05-07T00:10:00.000Z",
      payload: { task_id: "post-turn-task-1", task_kind: GardenTaskKind.TTL_CLEANUP, required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [], priority: 20,
        created_at: "2026-05-07T00:10:00.000Z" } });

    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    await handler.call({
      toolName: "garden.claim_task",
      arguments: { task_id: "post-turn-task-1" },
      context: defaultContext()
    });

    const completeResult = unwrapOk<{
      readonly status: string;
      readonly events_appended: number;
    }>(
      await handler.call({
        toolName: "garden.complete_task",
        arguments: {
          task_id: "post-turn-task-1",
          status: "completed",
          result_envelope: {
            candidate_signals: [
              {
                signal_kind: "potential_preference",
                object_kind: "memory_entry",
                scope_hint: "project",
                domain_tags: ["preference"],
                confidence: 0.78,
                evidence_refs: ["evidence-1"],
                source_memory_refs: ["memory-a"],
                raw_payload: {
                  observation: "user prefers vitest watch mode",
                  source_memory_refs: ["raw-memory"],
                  incompatible_with_refs: ["raw-conflict"]
                }
              }
            ]
          }
        },
        context: defaultContext()
      })
    );

    expect(completeResult.status).toBe("completed");
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals.find((signal) => signal.object_kind === "memory_entry")).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: ["memory-a"],
      incompatible_with_refs: [],
      raw_payload: {
        observation: "user prefers vitest watch mode",
        source_memory_refs: ["raw-memory"],
        incompatible_with_refs: ["raw-conflict"]
      }
    });
    expect(readRetainedPostTurnSource(harness.database, "post-turn-task-1")).toBeUndefined();
  });

  it("scheduler reclaims abandoned claims (status=claimed older than stale TTL) for another claimant", async () => {
    const now = "2026-05-07T00:10:00.000Z";
    const harness = await createRoutingHarness({
      provider_kind: "host_worker",
      now: () => now
    });
    harness.enqueuePostTurnTask();
    // Simulate an attached agent that claimed but never completed — row sits
    // in claimed state with a claimed_at timestamp older than the runtime's
    // GARDEN_CLAIM_STALE_AFTER_MS (10 min) ceiling. The scheduler tick must
    // reclaim it back to pending so another agent (or the same agent after
    // reconnect) can pick it up.
    const staleClaimedAt = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
    await harness.gardenTaskRepo.claimAtomic(
      "post-turn-task-1",
      "abandoned-agent",
      staleClaimedAt,
      "workspace-1"
    );
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "claimed",
      claimed_by: "abandoned-agent"
    });

    await harness.runScheduler();

    // Post-turn work is in-process only, so the same pass settles the reclaimed row.
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed",
      claimed_by: "in-process"
    });
    await expect(
      harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)
    ).resolves.toEqual({
      truncated: false,
      events: [
      expect.objectContaining({
        entity_id: "post-turn-task-1",
        payload_json: expect.objectContaining({
          previous_claimed_by: "abandoned-agent",
          stale_after_ms: 10 * 60 * 1000
        })
      })
      ]
    });
  });

  it("records session statement signals in the signal review queue", async () => {
    const harness = await createRoutingHarness({ provider_kind: "official_api",
      officialExtract: recordedStatementExtract(message => message.role === "user"
        ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : []) });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toEqual([expect.objectContaining({
      signal_id: gardenTaskSignalId(session!.id, 0),
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged"
    })]);
  });

});
