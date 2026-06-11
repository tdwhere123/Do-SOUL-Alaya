import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  RunMode,
  RunState,
  SignalSource,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { EventPublisher, SignalService } from "@do-soul/alaya-core";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import {
  createGardenBackgroundDataPorts,
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteHandoffGapRepo,
  SqliteHealthJournalRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { BackgroundServiceConfig } from "../../background/bootstrap.js";
import { createGardenRuntime } from "../../garden-runtime.js";
import { buildGardenTaskSignalId } from "../../garden-task-signal-id.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandler,
  type McpMemoryToolCallResult,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

const harnesses = new Set<ClosableHarness>();

afterEach(() => {
  for (const harness of harnesses) {
    harness.close();
  }
  harnesses.clear();
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
      workspace_id: "workspace-1"
    });
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
    const signalA = createSignal({ signal_id: "signal-official-a" });
    const signalB = createSignal({ signal_id: "signal-official-b" });
    const compile = vi.fn(async () => [signalA, signalB]);
    const harness = await createRoutingHarness({
      provider_kind: "official_api",
      officialCompile: compile
    });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();

    expect(compile).toHaveBeenCalledTimes(1);
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
      workspace_id: "workspace-1"
    });
    await expect(harness.signalRepo.getById(gardenTaskSignalId("post-turn-task-1", 1))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId("post-turn-task-1", 1),
      workspace_id: "workspace-1"
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
    harness.gardenTaskRepo.claimAtomic(
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

interface ClosableHarness {
  close(): void;
}

interface HandlerHarness extends ClosableHarness {
  readonly database: StorageDatabase;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly handler: McpMemoryToolHandler;
}

interface RoutingHarness extends ClosableHarness {
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly runRepo: SqliteRunRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly signalService: SignalService;
  readonly runtimeNotifier: { notifyEntry(entry: unknown): void };
  enqueuePostTurnTask(overrides?: {
    readonly id?: string;
    readonly payload?: PostTurnPayload;
    readonly created_at?: string;
  }): void;
  runScheduler(): Promise<void>;
}

interface GardenListPendingTasksOutput {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly payload: unknown;
  }[];
}

interface PostTurnPayload {
  readonly task_id?: string;
  readonly task_kind?: string;
  readonly required_tier?: string;
  readonly run_id: string;
  readonly target_object_refs?: readonly string[];
  readonly priority?: number;
  readonly created_at?: string;
  readonly turn_index: number;
  readonly workspace_id: string;
  readonly turn_digest: {
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly context_manifest: {
      readonly delivered_object_ids: readonly string[];
    };
  };
}

async function createHandlerHarness(options: {
  readonly delivery?: ContextDeliveryRecord | null;
} = {}): Promise<HandlerHarness> {
  const base = await createSqliteHarnessBase();
  const handler = createMcpMemoryToolHandler(createMcpDeps(base, options));
  const harness = {
    ...base,
    handler
  };
  harnesses.add(harness);
  return harness;
}

async function createRoutingHarness(options: {
  readonly provider_kind: RuntimeGardenComputeConfig["provider_kind"];
  readonly officialCompile?: GardenComputeProvider["compile"];
  readonly localCompile?: GardenComputeProvider["compile"];
}): Promise<RoutingHarness> {
  const base = await createSqliteHarnessBase();
  const signalService = new SignalService({
    eventLogRepo: base.eventLogRepo,
    signalRepo: base.signalRepo,
    runtimeNotifier: base.runtimeNotifier
  });
  const officialProvider = createProvider(
    "official_api",
    options.officialCompile ?? vi.fn(async () => [])
  );
  const localProvider = createProvider(
    "local_heuristics",
    options.localCompile ?? vi.fn(async () => [])
  );
  const runtime = createGardenRuntime({
    databaseConnection: base.database.connection,
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      snapshot_interval_ms: 1000
    },
    eventLogRepo: base.eventLogRepo,
    eventPublisher: base.eventPublisher,
    gardenDataPorts: createGardenBackgroundDataPorts(base.database),
    healthJournalRepo: new SqliteHealthJournalRepo(base.database),
    handoffGapRepo: new SqliteHandoffGapRepo(base.database),
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: new SqlitePathGraphSnapshotRepo(base.database),
    pathRelationRepo: new SqlitePathRelationRepo(base.database),
    configService: {
      getRuntimeGardenComputeConfig: async () =>
        ({
          provider_kind: options.provider_kind,
          model_id: "test-model",
          provider_url: null,
          secret_ref: options.provider_kind === "official_api" ? "env:ALAYA_TEST_GARDEN_KEY" : null,
          enabled: options.provider_kind !== "host_worker"
        }) satisfies RuntimeGardenComputeConfig
    },
    officialApiGardenProvider: officialProvider,
    localHeuristicsProvider: localProvider,
    signalReceiver: signalService,
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as Parameters<typeof createGardenRuntime>[0]["strongRefService"],
    workspaceRepo: base.workspaceRepo
  });
  const harness: RoutingHarness = {
    ...base,
    signalService,
    enqueuePostTurnTask(overrides = {}) {
      base.gardenTaskRepo.enqueue({
        id: overrides.id ?? "post-turn-task-1",
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: overrides.payload ?? createPostTurnPayload(),
        // Default to "just enqueued" so host_worker rows stay within the
        // in-process fallback wait window — the host worker gets first claim.
        // The bounded-fallback test below enqueues with an explicitly aged
        // created_at to exercise the zero-cloud heuristic fallback path.
        created_at: overrides.created_at ?? new Date().toISOString()
      });
    },
    async runScheduler() {
      await getService(runtime, "GardenScheduler").task();
    }
  };
  harnesses.add(harness);
  return harness;
}

async function createSqliteHarnessBase() {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const runtimeNotifier = {
    notify: vi.fn(),
    notifyEntry: vi.fn()
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier
  });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  await seedWorkspaceRun(workspaceRepo, runRepo);
  return {
    database,
    eventLogRepo,
    eventPublisher,
    gardenTaskRepo,
    runRepo,
    runtimeNotifier,
    signalRepo,
    workspaceRepo,
    close() {
      database.close();
    }
  };
}

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await seedRun(runRepo, "run-1");
}

async function seedRun(runRepo: SqliteRunRepo, runId: string): Promise<void> {
  await runRepo.create({
    run_id: runId,
    workspace_id: "workspace-1",
    title: runId,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createMcpDeps(base: {
  readonly eventPublisher: EventPublisher;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: { notifyEntry(entry: unknown): void };
}, options: {
  readonly delivery?: ContextDeliveryRecord | null;
} = {}): McpMemoryToolHandlerDependencies {
  const signalService = new SignalService({
    eventLogRepo: base.eventLogRepo,
    signalRepo: base.signalRepo,
    runtimeNotifier: base.runtimeNotifier
  });
  return {
    now: () => "2026-05-07T00:10:00.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001",
    recallService: {
      recall: async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      })
    },
    memoryService: {
      findById: async () => null,
      findByIdScoped: async (objectId, workspaceId) =>
        workspaceId === "workspace-1" ? createMemoryEntry({ object_id: objectId }) : null,
      update: async () => createMemoryEntry()
    },
    signalService: {
      receiveSignal: async (signal) => await signalService.receiveSignal(signal)
    },
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-1" })
    },
    trustStateRecorder: {
      recordDelivery: async (input) => ({ ...input, audit_event_id: "event-delivery" }),
      recordUsage: async (input) => ({ ...input, audit_event_id: "event-usage" }),
      findDeliveryById: async () => options.delivery === undefined ? createDeliveryRecord() : options.delivery
    },
    eventPublisher: base.eventPublisher,
    gardenTaskRepo: base.gardenTaskRepo
  };
}

async function recall(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly query: string;
    readonly recent_turn: string;
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  return await handler.call({
    toolName: "soul.recall",
    arguments: {
      query: overrides.query ?? "recall test query",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      ...(overrides.recent_turn === undefined ? {} : { recent_turn: overrides.recent_turn })
    },
    context: overrides.context ?? defaultContext()
  });
}

async function reportUsage(
  handler: McpMemoryToolHandler,
  overrides: Partial<{
    readonly turn_index: number;
    readonly usage_state: "used" | "skipped" | "not_applicable";
    readonly used_object_ids: readonly string[];
    readonly delivered_objects: readonly {
      readonly object_id: string;
      readonly usage_status: "used" | "skipped" | "not_applicable";
    }[];
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly context: McpMemoryToolCallContext;
  }> = {}
): Promise<McpMemoryToolCallResult> {
  const deliveredObjects =
    overrides.delivered_objects ?? [{ object_id: "memory-a", usage_status: "used" }] as const;
  const usedObjectIds = overrides.used_object_ids ??
    deliveredObjects
      .filter((object) => object.usage_status === "used")
      .map((object) => object.object_id);
  return await handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: "delivery-1",
      usage_state: overrides.usage_state ?? "used",
      used_object_ids: usedObjectIds,
      delivered_objects: deliveredObjects,
      turn_index: overrides.turn_index ?? 1,
      turn_digest: {
        last_messages:
          overrides.last_messages ?? [
            { role: "user", content_excerpt: "Remember that I prefer pnpm." },
            { role: "assistant", content_excerpt: "I used the project preference." }
          ]
      },
      reason: "post-turn extract test"
    },
    context: overrides.context ?? defaultContext()
  });
}

function postTurnRows(gardenTaskRepo: SqliteGardenTaskRepo) {
  return gardenTaskRepo
    .peekPending(GardenRole.LIBRARIAN, "workspace-1", 20)
    .filter((row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT);
}

function createProvider(
  provider_kind: GardenComputeProvider["provider_kind"],
  compile: GardenComputeProvider["compile"]
): GardenComputeProvider {
  return { provider_kind, compile };
}

function createPostTurnPayload(overrides: Partial<PostTurnPayload> = {}): PostTurnPayload {
  const payload: PostTurnPayload = {
    task_id: "post-turn-task-1",
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: "tier_2",
    run_id: "run-1",
    target_object_refs: ["memory-a"],
    priority: 20,
    created_at: "2026-05-07T00:00:00.000Z",
    turn_index: 3,
    workspace_id: "workspace-1",
    turn_digest: {
      last_messages: [
        { role: "user", content_excerpt: "I prefer pnpm commands in this repo." },
        { role: "assistant", content_excerpt: "Acknowledged and applied." }
      ],
      context_manifest: {
        delivered_object_ids: ["memory-a"]
      }
    }
  };
  return { ...payload, ...overrides };
}

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-post-turn",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: "potential_preference",
    signal_state: "emitted",
    object_kind: "memory_entry",
    scope_hint: "project",
    domain_tags: ["test"],
    confidence: 0.9,
    evidence_refs: ["memory-a"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { observation: "post-turn extraction test" },
    created_at: "2026-05-07T00:11:00.000Z",
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<ReturnType<typeof createMemoryEntryBase>> = {}) {
  return {
    ...createMemoryEntryBase(),
    ...overrides
  } as const;
}

function createMemoryEntryBase() {
  return {
    // Widened from the "memory-a" literal so callers can override with a
    // dynamic object_id (e.g. findByIdScoped echoing its argument).
    object_id: "memory-a" as string,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Use pnpm.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  } as const;
}

function createDeliveryRecord(overrides: Partial<ContextDeliveryRecord> = {}): ContextDeliveryRecord {
  return {
    delivery_id: "delivery-1",
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    // Both memory-a and memory-b are served by this delivery so a usage report
    // that cites either id stays a subset of the server-side delivered set.
    // see also: mcp-memory/tool-handler.ts validateReportedRecallHits.
    delivered_object_ids: ["memory-a", "memory-b"],
    delivered_at: "2026-05-07T00:00:00.000Z",
    audit_event_id: "event-delivery",
    ...overrides
  };
}

function defaultContext(): McpMemoryToolCallContext {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    agentTarget: "codex",
    sessionId: "post-turn-extract-test-session",
    surfaceId: "post-turn-extract-test"
  };
}

function noRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: null,
    sessionId: "mcp-session-without-run"
  };
}

function sessionRunContext(): McpMemoryToolCallContext {
  return {
    ...defaultContext(),
    runId: "mcp-session-run-1",
    sessionId: "mcp-session-run-1"
  };
}

function getService(runtime: ReturnType<typeof createGardenRuntime>, name: string): BackgroundServiceConfig {
  const services = (runtime.backgroundManager as unknown as {
    readonly services: readonly BackgroundServiceConfig[];
  }).services;
  const service = services.find((candidate) => candidate.name === name);
  if (service === undefined) {
    throw new Error(`Missing background service ${name}.`);
  }
  return service;
}

function unwrapOk<T>(result: McpMemoryToolCallResult): T {
  expect(result).toMatchObject({ ok: true });
  return (result as Extract<McpMemoryToolCallResult, { ok: true }>).output as T;
}

const gardenTaskSignalId = buildGardenTaskSignalId;
