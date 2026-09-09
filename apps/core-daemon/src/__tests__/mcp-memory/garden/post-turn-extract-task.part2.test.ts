import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvidenceHealthState,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  SignalSource,
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceRootRecallReader
} from "@do-soul/alaya-storage";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../../garden/support/task-signal-id.js";

import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

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
      raw_payload: { evidence_preservation: { reason: "empty_extraction" } }
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
    const now = "2026-05-07T00:10:00.000Z";
    const officialCompile = vi.fn(async () => [createSignal()]);
    const localCompile = vi.fn(async () => [createSignal({ signal_id: "signal-fallback" })]);
    const harness = await createRoutingHarness({
      provider_kind: "host_worker",
      now: () => now,
      officialCompile,
      localCompile
    });
    // Enqueued well before the host-worker fallback window (created_at aged 1h)
    // with no agent claim. The in-process runtime must claim it and run the
    // deterministic localHeuristicsProvider so the extract never stalls — and
    // must NOT touch the official (cloud) provider.
    harness.enqueuePostTurnTask({
      created_at: new Date(Date.parse(now) - 60 * 60 * 1000).toISOString()
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
    await expect(harness.signalRepo.getById(
      buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1")
    )).resolves.toMatchObject({
      object_kind: "source_turn",
      raw_payload: { evidence_preservation: { reason: "empty_extraction" } }
    });
  });

  it("failed compile still leaves a discoverable SQLite source root", async () => {
    const compile = vi.fn(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile,
      receiveSignal: async (signal) => {
        const gist = typeof signal.raw_payload === "object"
          && signal.raw_payload !== null
          && !Array.isArray(signal.raw_payload)
          && typeof signal.raw_payload.full_turn_content === "string"
          ? signal.raw_payload.full_turn_content
          : "retained original turn";
        await new SqliteEvidenceCapsuleRepo(harness.database).create({
          object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          object_kind: "evidence_capsule",
          schema_version: 1,
          lifecycle_state: "active",
          created_at: "2026-05-07T00:10:00.000Z",
          updated_at: "2026-05-07T00:10:00.000Z",
          created_by: "user_action",
          evidence_kind: "conversation_excerpt",
          semantic_anchor: { topic: "source", keywords: ["source"], summary: gist },
          event_anchor: null,
          physical_anchor: null,
          evidence_health_state: EvidenceHealthState.VERIFIED,
          gist,
          excerpt: gist,
          source_hash: null,
          run_id: signal.run_id,
          workspace_id: signal.workspace_id,
          surface_id: null
        });
        return { signal };
      }
    });
    harness.enqueuePostTurnTask();

    await expect(harness.runScheduler()).resolves.toBeUndefined();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({
      status: "failed"
    });

    const roots = new SqliteSourceRootRecallReader(
      new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256),
      new SqliteEvidenceCapsuleRepo(harness.database)
    ).page({
      workspaceId: "workspace-1",
      limit: 8,
      nativeLimit: 8,
      afterCursor: null
    });
    expect(roots.rows.some((row) =>
      row.kind === "evidence_capsule"
      && row.root_id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      && (row.content ?? "").includes("I prefer pnpm commands")
    )).toBe(true);
  });

  it("enqueue of a turn longer than 800 chars keeps the unsliced root after a throwing provider", async () => {
    const tail = "BEYOND_EIGHT_HUNDRED_MARKER";
    const excerpt = `${"a".repeat(800)}${tail}`;
    const compile = vi.fn(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({
      provider_kind: "local_heuristics",
      localCompile: compile
    });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));

    expect((await reportUsage(handler, {
      turn_index: 21,
      last_messages: [{ role: "user", content_excerpt: excerpt }]
    })).ok).toBe(true);

    const enqueued = postTurnRows(harness.gardenTaskRepo);
    expect(enqueued).toHaveLength(1);
    const taskId = enqueued[0]!.id;
    const payload = enqueued[0]!.payload as PostTurnPayload;
    expect(payload.turn_digest.last_messages[0]!.content_excerpt).toHaveLength(800);
    expect(payload.turn_digest.last_messages[0]!.content_excerpt.includes(tail)).toBe(false);
    expect(payload.admitted_source_root_id).toMatch(/^sha256:[0-9a-f]{64}$/u);

    await expect(harness.runScheduler()).resolves.toBeUndefined();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(String(compile.mock.calls[0]?.[0] ?? "")).not.toContain(tail);
    expect(harness.gardenTaskRepo.findById(taskId)).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    });

    const roots = pageWorkspaceSourceRoots(harness.database);
    expect(roots.rows.some((row) =>
      row.kind === "source_record"
      && row.original_complete === true
      && (row.content ?? "").includes(tail)
      && (row.content ?? "").length > 800
    )).toBe(true);
    expect(roots.rows.some((row) =>
      row.original_complete === true
      && (row.content ?? "").length > 0
      && !(row.content ?? "").includes(tail)
    )).toBe(false);
    expect(
      (harness.database.connection.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
        count: number;
      }).count
    ).toBe(0);
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
    expect(signals).toHaveLength(2);
    expect(signals.find((signal) => signal.object_kind === "memory_entry")).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: ["memory-a"],
      incompatible_with_refs: ["memory-b"],
      raw_payload: { observation: "user prefers vitest watch mode" }
    });
    expect(signals.find((signal) => signal.object_kind === "source_turn")).toMatchObject({
      signal_id: buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1")
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
    expect(signals).toHaveLength(2);
    expect(signals.find((signal) => signal.object_kind === "memory_entry")).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: [],
      raw_payload: {
        observation: "user prefers vitest watch mode",
        source_memory_refs: "legacy metadata, not a graph hint"
      }
    });
    expect(signals.find((signal) => signal.object_kind === "source_turn")).toMatchObject({
      signal_id: buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1")
    });
  });

  it("scheduler reclaims abandoned claims (status=claimed older than stale TTL) back to pending", async () => {
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
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal_id: gardenTaskSignalId("post-turn-task-1", 0),
        source: SignalSource.GARDEN_COMPILE,
        signal_state: "triaged"
      }),
      expect.objectContaining({
        signal_id: buildGardenTaskEvidenceFallbackSignalId("post-turn-task-1"),
        object_kind: "source_turn"
      })
    ]));
    expect(signals).toHaveLength(2);
  });
});
