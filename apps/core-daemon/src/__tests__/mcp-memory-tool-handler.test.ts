import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";

const context = {
  workspaceId: "ws1",
  runId: "run1",
  agentTarget: "codex",
      sessionId: "mcp-memory-tool-handler-session",
};

describe("mcp memory tool handler", () => {
  it("routes recall through RecallService and records trust delivery", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        runId: "run1",
        strategy: "chat"
      })
    );
    expect(deps.trustStateRecorder.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_target: "codex",
        workspace_id: "ws1",
        run_id: "run1",
        delivered_object_ids: ["mem1"]
      })
    );
    expect(result.ok && result.output).toMatchObject({
      delivery_id: "delivery_00000000-0000-4000-8000-000000000003",
      total_count: 1,
      degradation_reason: "recall_explainability_partial"
    });
  });

  it("omits timeFilter when the request has no time bounds", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });

    const callArg = (deps.recallService.recall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg!.timeFilter).toBeUndefined();
  });

  it("threads since/until/time_field from request into recallService.recall as timeFilter", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "what did I say on May 20",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3,
        since: "2026-05-20T00:00:00.000Z",
        until: "2026-05-20T23:59:59.000Z",
        time_field: "created_at"
      },
      context
    });

    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        timeFilter: {
          since: "2026-05-20T00:00:00.000Z",
          until: "2026-05-20T23:59:59.000Z",
          field: "created_at"
        }
      })
    );
  });

  it("threads host_context from recall requests into RecallService", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3,
        host_context: {
          tokenizer_hint: "cl100k",
          host_context_window: 128000
        }
      },
      context
    });

    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        hostContext: {
          tokenizer_hint: "cl100k",
          host_context_window: 128000
        }
      })
    );
  });

  it("defaults time_field to created_at when only since is provided", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "recent context",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3,
        since: "2026-05-01T00:00:00.000Z"
      },
      context
    });

    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        timeFilter: expect.objectContaining({
          since: "2026-05-01T00:00:00.000Z",
          field: "created_at"
        })
      })
    );
  });

  it("prefers cascade degradation over explainability partial degradation", async () => {
    const deps = createDeps();
    deps.recallService.recall = vi.fn(async () => ({
      candidates: [
        {
          object_id: "mem1",
          object_kind: "memory_entry",
          activation_score: 0.9,
          relevance_score: 0.8,
          content_preview: "deployment rules",
          token_estimate: 12,
          manifestation: "excerpt",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          origin_plane: "workspace_local"
        }
      ],
      total_scanned: 1,
      coarse_filter_count: 1,
      fine_assessment_count: 1,
      degradation_reason: "cold_cascade_engaged"
    }));
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });

    expect(result.ok && result.output).toMatchObject({
      degradation_reason: "cold_cascade_engaged"
    });
  });

  it("opens memory pointers without mutating state", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { object_id: "mem1" },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.memoryService.findByIdScoped).toHaveBeenCalledWith("mem1", context.workspaceId);
    expect(result.ok && result.output).toMatchObject({
      object_id: "mem1",
      object_kind: "memory_entry"
    });
  });

  it("does not open memory pointers outside the caller workspace", async () => {
    const deps = createDeps();
    // F-r2-002: handler now uses findByIdScoped; foreign workspace returns null.
    deps.memoryService.findByIdScoped = vi.fn(async (_objectId: string, _workspaceId: string) => null);
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { object_id: "mem1" },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" }
    });
  });

  it("records usage proof against an existing delivery", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        per_anchor_usage: [{ object_id: "mem1", anchor_role: "target" }],
        reason: "cited"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        per_anchor_usage: [{ object_id: "mem1", anchor_role: "target" }],
        reason: "cited"
      }),
      // D2 MERGED-B3: handler now passes the call-context workspace as
      // an expected-workspace guard so cross-workspace report_context_usage
      // is rejected at the trust-state layer before any MEMORY_USAGE_REPORTED
      // row is appended.
      { expectedWorkspaceId: context.workspaceId }
    );
  });

  it("recall-hit-tier-promotion refreshes used memory access while promoting to hot", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1", "mem1"],
        per_anchor_usage: [{ object_id: "mem1", anchor_role: "target" }],
        reason: "cited"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.memoryService.findByIdScoped).toHaveBeenCalledWith("mem1", "ws1");
    expect(deps.memoryService.updateScoped).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.updateScoped).toHaveBeenCalledWith(
      "mem1",
      "ws1",
      {
        storage_tier: "hot",
        last_used_at: "2026-04-30T00:00:00.000Z",
        last_hit_at: "2026-04-30T00:00:00.000Z"
      },
      "recall_usage_reported"
    );
  });

  it("does not refresh recall access for skipped reports", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "skipped",
        used_object_ids: [],
        reason: "not relevant"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("maps trust-state usage validation failures to MCP validation errors", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.recordUsage = vi.fn(async () => {
      const error = new Error("Per-anchor usage references object_id that was not delivered: mem2");
      (error as Error & { code: "VALIDATION" }).code = "VALIDATION";
      throw error;
    });
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        per_anchor_usage: [{ object_id: "mem2", anchor_role: "target" }],
        reason: "spoofed"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Per-anchor usage references object_id that was not delivered: mem2"
      }
    });
  });

  it("fails closed for unsupported tools and invalid input", async () => {
    const handler = createMcpMemoryToolHandler(createDeps());

    await expect(
      handler.call({ toolName: "memory.recall", arguments: {}, context })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" }
    });

    await expect(
      handler.call({ toolName: "soul.recall", arguments: { query: "" }, context })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
  });

  it("fails closed when proposal workflow is unavailable", async () => {
    const handler = createMcpMemoryToolHandler(createDeps());

    const result = await handler.call({
      toolName: "soul.propose_memory_update",
      arguments: {
        target_object_id: "mem1",
        proposed_changes: { content: "next" },
        reason: "user correction"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("threads source delivery anchors through emit_candidate_signal and warns when MODEL_TOOL omits them", async () => {
    const warn = vi.fn();
    const deps = { ...createDeps(), warn };
    const handler = createMcpMemoryToolHandler(deps);

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Use pnpm." },
          source_delivery_ids: ["delivery-1", "delivery-2"]
        },
        context
      })
    ).resolves.toMatchObject({ ok: true });

    expect(deps.signalService.receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "model_tool",
        source_delivery_ids: ["delivery-1", "delivery-2"]
      })
    );
    expect(warn).not.toHaveBeenCalled();

    await expect(
      handler.call({
        toolName: "soul.emit_candidate_signal",
        arguments: {
          signal_kind: "potential_preference",
          object_kind: "memory_entry",
          scope_hint: "project",
          domain_tags: ["tooling"],
          confidence: 0.9,
          evidence_refs: ["memory-1"],
          raw_payload: { observation: "Missing anchor." }
        },
        context
      })
    ).resolves.toMatchObject({ ok: true });

    expect(warn).toHaveBeenCalledWith(
      "MODEL_TOOL candidate signal emitted without source_delivery_ids.",
      expect.objectContaining({
        source: "model_tool"
      })
    );
  });
});

function createDeps(): McpMemoryToolHandlerDependencies {
  let idCounter = 0;
  return {
    now: () => "2026-04-30T00:00:00.000Z",
    generateId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [
          {
            object_id: "mem1",
            object_kind: "memory_entry",
            activation_score: 0.9,
            relevance_score: 0.8,
            content_preview: "deployment rules",
            token_estimate: 12,
            manifestation: "excerpt",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            origin_plane: "workspace_local"
          }
        ],
        total_scanned: 1,
        coarse_filter_count: 1,
        fine_assessment_count: 1
      }))
    },
    memoryService: {
      findById: vi.fn(async () => createMemory()),
      findByIdScoped: vi.fn(async (_objectId: string, workspaceId: string) => {
        const entry = createMemory();
        return entry.workspace_id === workspaceId ? entry : null;
      }),
      update: vi.fn(async (_objectId, fields) => createMemory(fields)),
      updateScoped: vi.fn(async (_objectId, _workspaceId, fields) => createMemory(fields))
    },
    signalService: {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override1" }))
    },
    trustStateRecorder: {
      recordDelivery: vi.fn(async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event1"
      })),
      recordUsage: vi.fn(async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
        ...input,
        audit_event_id: "event2"
      })),
      findDeliveryById: vi.fn(async () => null)
    }
  };
}

function createMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "mem1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    lifecycle_state: "active",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "deployment rules",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws1",
    run_id: "run1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
