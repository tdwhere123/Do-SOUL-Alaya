import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  SignalSource,
} from "@do-soul/alaya-protocol";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";

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

  it("used context usage enqueues one host-worker POST_TURN_EXTRACT task", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      turn_index: 7,
      delivered_objects: [
        { object_id: "memory-a", usage_status: "skipped" },
        { object_id: "memory-b", usage_status: "used" }
      ],
      last_messages: [
        { role: "user", content_excerpt: "x".repeat(900) },
        { role: "assistant", content_excerpt: "Used memory-b in the answer." }
      ]
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      status: "pending"
    });
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(payload).toMatchObject({
      run_id: "run-1",
      turn_index: 7,
      workspace_id: "workspace-1",
      source_observation: {
        observed_at: "2026-05-07T00:00:00.000Z",
        authority: "verified_delivery_observation",
        source_event_id: "event-delivery"
      }
    });
    expect(payload).not.toHaveProperty("source_observed_at");
    expect(payload.turn_digest.context_manifest.delivered_object_ids).toEqual([
      "memory-a",
      "memory-b"
    ]);
    expect(payload.turn_digest.last_messages[0]!.content_excerpt).toHaveLength(800);

    const listed = unwrapOk<GardenListPendingTasksOutput>(
      await harness.handler.call({
        toolName: "garden.list_pending_tasks",
        arguments: { role: "host_worker", limit: 10 },
        context: defaultContext()
      })
    );
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      role: "host_worker",
      kind: GardenTaskKind.POST_TURN_EXTRACT
    });
  });

  it("ignores a public usage timestamp and persists the verified delivery observation", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      turn_index: 11,
      source_observed_at: "1999-01-01T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    const payload = postTurnRows(harness.gardenTaskRepo)[0]!.payload as PostTurnPayload;
    expect(payload).not.toHaveProperty("source_observed_at");
    expect(payload.source_observation).toEqual({
      observed_at: "2026-05-07T00:00:00.000Z",
      authority: "verified_delivery_observation",
      source_event_id: "event-delivery"
    });
  });

  it("usage report with no run id and no linked delivery enqueues no extract work", async () => {
    const harness = await createHandlerHarness({ delivery: null });

    const result = await reportUsage(harness.handler, {
      turn_index: 8,
      context: noRunContext()
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("usage report with an attached session run enqueues extract work scoped to the linked delivery run", async () => {
    const harness = await createHandlerHarness({
      delivery: createDeliveryRecord({ run_id: "mcp-session-run-1" })
    });

    const result = await reportUsage(harness.handler, {
      turn_index: 8,
      context: sessionRunContext()
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as PostTurnPayload).run_id).toBe("mcp-session-run-1");
  });

  it("delayed usage reports enqueue extract work under the linked delivery run", async () => {
    const harness = await createHandlerHarness({
      delivery: createDeliveryRecord({ run_id: "run-original" })
    });

    const result = await reportUsage(harness.handler, {
      turn_index: 9,
      context: {
        ...defaultContext(),
        runId: "run-reporter",
        sessionId: "later-session"
      }
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(payload.run_id).toBe("run-original");
  });

  it("skipped and not_applicable usage still enqueue extract work when a turn_digest is present", async () => {
    const harness = await createHandlerHarness();

    await reportUsage(harness.handler, {
      turn_index: 1,
      usage_state: "skipped",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-a", usage_status: "skipped" }]
    });
    await reportUsage(harness.handler, {
      turn_index: 2,
      usage_state: "not_applicable",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-b", usage_status: "not_applicable" }]
    });

    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT && row.status === "pending"
      )
    ).toBe(true);
  });

  it("a report with an empty turn_digest enqueues no extract work", async () => {
    const harness = await createHandlerHarness();

    await reportUsage(harness.handler, {
      turn_index: 1,
      usage_state: "skipped",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-a", usage_status: "skipped" }],
      last_messages: []
    });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("dedupes concurrent reports for the same workspace run and turn", async () => {
    const harness = await createHandlerHarness();

    const calls = await Promise.all([
      reportUsage(harness.handler, { turn_index: 42 }),
      reportUsage(harness.handler, { turn_index: 42 })
    ]);

    expect(calls.every((result) => result.ok)).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
  });

  it("a recall with a long query enqueues a recall-driven extract task from the turn text", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "remember that I always use pnpm for this project"
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id.startsWith("recall_extract_")).toBe(true);
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(payload.run_id).toBe("run-1");
    expect(payload.workspace_id).toBe("workspace-1");
    expect(payload.turn_digest.last_messages).toEqual([
      { role: "user", content_excerpt: "remember that I always use pnpm for this project" }
    ]);
    expect(payload.source_observation).toBeUndefined();
    expect(payload).not.toHaveProperty("source_observed_at");
  });

  it("does not persist a public recall timestamp without a verified delivery", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, {
      query: "remember that I always use pnpm for this project",
      source_observed_at: "1999-01-01T00:00:00.000Z"
    });

    const payload = postTurnRows(harness.gardenTaskRepo)[0]!.payload as PostTurnPayload;
    expect(payload.source_observation).toBeUndefined();
    expect(payload).not.toHaveProperty("source_observed_at");
  });

  it("prefers recent_turn over query for the recall-driven extract task", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "From now on always reply to me in Chinese for this project."
    });

    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as PostTurnPayload).turn_digest.last_messages[0]!.content_excerpt).toBe(
      "From now on always reply to me in Chinese for this project."
    );
  });

  it("recall with no run id enqueues no extract work", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "Please remember that I do not want fixable issues parked in backlog.",
      context: noRunContext()
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("recall with an attached session run enqueues recall-driven extract work", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "Please remember that I do not want fixable issues parked in backlog.",
      context: sessionRunContext()
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(rows[0]!.id.startsWith("recall_extract_")).toBe(true);
    expect(payload.run_id).toBe("mcp-session-run-1");
    expect(payload.turn_digest.last_messages[0]!.content_excerpt).toBe(
      "Please remember that I do not want fixable issues parked in backlog."
    );
  });

  it("does not enqueue a recall-driven extract task for a short query and no recent_turn", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "pnpm" });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("dedupes repeated recalls for the same turn text within a run", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });
    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });

    expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
  });

  it("a report for the same recalled user message does not enqueue duplicate extract work", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });
    await reportUsage(harness.handler, {
      turn_index: 3,
      last_messages: [
        { role: "user", content_excerpt: "remember that I always use pnpm for this project" },
        { role: "assistant", content_excerpt: "I used the project preference." }
      ]
    });

    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id.startsWith("recall_extract_")).toBe(true);
  });

  it("skips the recall-driven extract task when the librarian queue is already saturated", async () => {
    const harness = await createHandlerHarness();
    for (let i = 0; i < 128; i += 1) {
      harness.gardenTaskRepo.enqueue({
        id: `seed-extract-${i}`,
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: createPostTurnPayload(),
        created_at: "2026-05-07T00:00:00.000Z"
      });
    }

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });

    expect(harness.gardenTaskRepo.findById("seed-extract-0")).not.toBeNull();
    expect(
      harness.gardenTaskRepo
        .peekPending(GardenRole.LIBRARIAN, "workspace-1", 256)
        .filter((row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT && row.id.startsWith("recall_extract_"))
    ).toEqual([]);
  });

  it("official_api healthy routing claims, compiles, completes, and records two signals", async () => {
    const signalA = createSignal({
      signal_id: "signal-official-a",
      source_observation: {
        observed_at: "2026-05-01T00:00:00.000Z",
        authority: "verified_delivery_observation",
        source_event_id: "model-forged-event"
      }
    });
    const signalB = createSignal({ signal_id: "signal-official-b" });
    const compile = vi.fn(async () => [signalA, signalB]);
    const harness = await createRoutingHarness({
      provider_kind: "official_api",
      officialCompile: compile
    });
    harness.enqueuePostTurnTask({
      payload: createPostTurnPayload({
        source_observation: {
          observed_at: "2026-05-07T00:00:00.000Z",
          authority: "verified_delivery_observation",
          source_event_id: "event-delivery"
        }
      })
    });

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source_observed_at: "2026-05-07T00:00:00.000Z" })
    );
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "completed",
      claimed_by: "in-process"
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents.at(-1)?.payload_json).toMatchObject({
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      success: true,
      candidate_signals_count: 2
    });
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 0))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId("post-turn-task-1", 0),
      workspace_id: "workspace-1",
      source_observation: {
        observed_at: "2026-05-07T00:00:00.000Z",
        authority: "verified_delivery_observation",
        source_event_id: "event-delivery"
      }
    });
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 1))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId("post-turn-task-1", 1),
      workspace_id: "workspace-1"
    });
  });

  it("sets null source observation when a host-worker task has no persisted delivery proof", async () => {
    const compile = vi.fn<GardenComputeProvider["compile"]>(async () => [createSignal({
      source_observation: {
        observed_at: "1999-01-01T00:00:00.000Z",
        authority: "verified_delivery_observation",
        source_event_id: "model-forged-event"
      }
    })]);
    const harness = await createRoutingHarness({
      provider_kind: "official_api",
      officialCompile: compile
    });
    harness.enqueuePostTurnTask({ payload: createPostTurnPayload({ source_observation: null }) });

    await harness.runScheduler();

    expect(compile.mock.calls[0]?.[1]?.source_observed_at).toBeUndefined();
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 0))).resolves.toMatchObject({
      source_observation: null
    });
  });

  it("host_worker routing leaves a freshly-enqueued task pending for MCP workers", async () => {
    const officialCompile = vi.fn(async () => [createSignal()]);
    const localCompile = vi.fn(async () => [createSignal()]);
    const harness = await createRoutingHarness({
      provider_kind: "host_worker",
      officialCompile,
      localCompile
    });
    // Just enqueued (default created_at = now) -> within the host-worker wait
    // window, so the in-process runtime leaves it for an attached agent and
    // does NOT run any provider inline.
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(officialCompile).not.toHaveBeenCalled();
    expect(localCompile).not.toHaveBeenCalled();
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const listed = unwrapOk<GardenListPendingTasksOutput>(
      await handler.call({
        toolName: "garden.list_pending_tasks",
        arguments: { role: "host_worker", limit: 10 },
        context: defaultContext()
      })
    );
    expect(listed.tasks).toEqual([
      expect.objectContaining({
        task_id: "post-turn-task-1",
        role: "host_worker",
        kind: GardenTaskKind.POST_TURN_EXTRACT
      })
    ]);
  });
});
