import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  SignalSource,
} from "@do-soul/alaya-protocol";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../garden/index.js";

import { createMcpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";

import {
  cleanupPostTurnExtractHarnesses,
  createMcpDeps,
  createDeliveryRecord,
  createHandlerHarness,
  createPostTurnPayload,
  createRoutingHarness,
  createSignal,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
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

  it("persists one evidence anchor when in-process extraction returns no candidates", async () => {
    const compile = vi.fn(async () => []);
    const harness = await createRoutingHarness({
      provider_kind: "official_api",
      officialCompile: compile
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed"
    });
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_id: buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1"),
      source: "garden_compile",
      signal_kind: "potential_evidence_anchor",
      object_kind: "source_turn",
      raw_payload: {
        evidence_preservation: { reason: "empty_extraction" }
      }
    });
  });

  it("adds a stable evidence fallback when nonempty extraction creates no evidence", async () => {
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1");
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: vi.fn(async () => [createSignal()]),
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    await expect(harness.signalRepo.getById(fallbackId)).resolves.toMatchObject({
      signal_id: fallbackId,
      raw_payload: { evidence_preservation: { reason: "no_evidence_created" } }
    });
  });

  it("fails the task when the evidence fallback cannot satisfy the durable postcondition", async () => {
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: vi.fn(async () => []),
      hasCreatedEvidence: async () => false
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("evidence fallback did not create durable evidence")
    });
  });

  it("host_worker routing falls back to the zero-cloud local heuristic after the wait window with no claim", async () => {
    const officialCompile = vi.fn(async () => [createSignal()]);
    const localCompile = vi.fn(async () => [createSignal({ signal_id: "signal-fallback" })]);
    const harness = await createRoutingHarness({
      provider_kind: "host_worker",
      officialCompile,
      localCompile
    });
    // Enqueued well before the host-worker fallback window (created_at aged 1h)
    // with no agent claim. The in-process runtime must claim it and run the
    // deterministic localHeuristicsProvider so the extract never stalls — and
    // must NOT touch the official (cloud) provider.
    harness.enqueuePostTurnTask({
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });

    await harness.runScheduler();

    expect(officialCompile).not.toHaveBeenCalled();
    expect(localCompile).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed",
      claimed_by: "in-process"
    });
    await expect(
      harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 0))
    ).resolves.toMatchObject({
      signal_id: gardenTaskSignalId("post-turn-task-1", 0),
      workspace_id: "workspace-1"
    });
  });

  it("local_heuristics routing claims, compiles, and completes inline", async () => {
    const localCompile = vi.fn(async () => [createSignal({ signal_id: "signal-local" })]);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(localCompile).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed",
      claimed_by: "in-process"
    });
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 0))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId("post-turn-task-1", 0)
    });
  });

  it("local_heuristics routing persists signals for canonical attached session runs", async () => {
    const localCompile = vi.fn(async (_content, context) => [
      createSignal({ signal_id: "signal-session-run", run_id: context.run_id })
    ]);
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile
    });
    await seedRun(harness.runRepo, "mcp-session-run-1");
    harness.enqueuePostTurnTask({
      id: "post-turn-session-task",
      payload: createPostTurnPayload({
        task_id: "post-turn-session-task",
        run_id: "mcp-session-run-1"
      })
    });

    await harness.runScheduler();

    expect(harness.gardenTaskRepo.findById("post-turn-session-task")).toMatchObject({
      status: "completed"
    });
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-session-task", 0))).resolves.toMatchObject({
      run_id: "mcp-session-run-1",
      signal_id: gardenTaskSignalId("post-turn-session-task", 0)
    });
  });

  it("a failing extract provider marks the task failed without aborting the background pass", async () => {
    const compile = vi.fn(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    harness.enqueuePostTurnTask();

    await expect(harness.runScheduler()).resolves.toBeUndefined();

    expect(compile).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents.at(-1)?.payload_json).toMatchObject({
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      success: false,
      candidate_signals_count: 0
    });
  });

  it("host_worker end-to-end: enqueue then MCP claim/complete delivers candidate signals", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "pending",
      claimed_by: null
    });

    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const claimResult = unwrapOk<{
      readonly status: string;
      readonly task_id: string;
    }>(
      await handler.call({
        toolName: "garden.claim_task",
        arguments: { task_id: "post-turn-task-1" },
        context: defaultContext()
      })
    );
    expect(claimResult.status).toBe("claimed");
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "claimed",
      claimed_by: defaultContext().agentTarget
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
                // invariant: graph-edge ref hints are first-class on
                // CandidateMemorySignal (see candidate-memory-signal.ts §79-84).
                // raw_payload is not a back-door for them.
                source_memory_refs: ["memory-a"],
                incompatible_with_refs: ["memory-b"],
                raw_payload: {
                  observation: "user prefers vitest watch mode"
                }
              }
            ]
          }
        },
        context: defaultContext()
      })
    );
    expect(completeResult.status).toBe("completed");
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed"
    });
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: ["memory-a"],
      incompatible_with_refs: ["memory-b"],
      raw_payload: { observation: "user prefers vitest watch mode" }
    });
  });

  it("ignores raw_payload graph ref keys when completing Garden tasks (first-class fields only)", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.enqueuePostTurnTask();
    await harness.runScheduler();

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
                raw_payload: {
                  observation: "user prefers vitest watch mode",
                  source_memory_refs: "legacy metadata, not a graph hint"
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
    expect(signals[0]).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: [],
      raw_payload: {
        observation: "user prefers vitest watch mode",
        source_memory_refs: "legacy metadata, not a graph hint"
      }
    });
  });

  it("scheduler reclaims abandoned claims (status=claimed older than stale TTL) back to pending", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.enqueuePostTurnTask();
    // Simulate an attached agent that claimed but never completed — row sits
    // in claimed state with a claimed_at timestamp older than the runtime's
    // GARDEN_CLAIM_STALE_AFTER_MS (10 min) ceiling. The scheduler tick must
    // reclaim it back to pending so another agent (or the same agent after
    // reconnect) can pick it up.
    const staleClaimedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
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

    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    await expect(
      harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)
    ).resolves.toEqual([
      expect.objectContaining({
        entity_id: "post-turn-task-1",
        payload_json: expect.objectContaining({
          previous_claimed_by: "abandoned-agent",
          stale_after_ms: 10 * 60 * 1000
        })
      })
    ]);
  });

  it("records compiled candidate signals in the signal review queue", async () => {
    const harness = await createRoutingHarness({
      provider_kind: "official_api",
      officialCompile: vi.fn(async () => [
        createSignal({ signal_id: "signal-review-queue", confidence: 0.91 })
      ])
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toEqual([
      expect.objectContaining({
        signal_id: gardenTaskSignalId("post-turn-task-1", 0),
        source: SignalSource.GARDEN_COMPILE,
        signal_state: "triaged"
      })
    ]);
  });
});
