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
  agentTarget: "codex"
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
      total_count: 1
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
        reason: "cited"
      })
    );
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
      })
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
      }))
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
