import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema,
  type RecallPolicy,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  buildRecallPolicy
} from "@do-soul/alaya-core";
import { createTaskSurface } from
  "../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { runProductionBoundRecall } from "../../mcp-memory/recall/recall-bound-service.js";
import type { RecallUsageHandlerDependencies } from "../../mcp-memory/recall/recall-usage-handlers.js";
import { invokeBoundRecall, type BoundRecallInvokeParams } from "../../recall/recall-bound-execution.js";
import { HARD_IDENTITY_CAP_CONTRACT } from "../../../../../packages/core/src/recall/conditional-field/cap-contract.js";

function makeSharedPolicy(): RecallPolicy {
  const taskSurfaceId = randomUUID();
  return buildRecallPolicy({
    runtimeId: randomUUID(),
    taskSurfaceId,
    maxResults: 5,
    filters: {
      scopeFilter: null,
      dimensionFilter: null,
      domainTagFilter: null
    },
    conflictAwareness: true,
    maxTotalTokens: 2000
  });
}

function makeTaskSurface(policy: RecallPolicy) {
  return TaskObjectSurfaceSchema.parse({
    runtime_id: policy.task_surface_ref,
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "mcp_memory_tool",
    display_name: "deployment rules",
    context_refs: []
  });
}

function makeSearchRequest(
  overrides: Partial<SoulMemorySearchRequest> = {}
): SoulMemorySearchRequest {
  return {
    protocol_version: 1,
    supported_result_kinds: ["memory_entry", "source_evidence"],
    supports_source_evidence: true,
    supports_product_updates: true,
    query: "deployment rules",
    max_results: 5,
    scope_class: null,
    dimension: null,
    domain_tags: null,
    ...overrides
  };
}

describe("invokeBoundRecall request forwarding", () => {
  it("forwards target request options without normalizing clock or replacing the caller budget", async () => {
    const recall = vi.fn(async (_params: BoundRecallInvokeParams) => "result");
    const budget = { schema_version: 1 as const, work_units: 1000, memory_bytes: 65536,
      page_budget: 1, finalization_reserve: 100, min_envelope: 10 };
    const options = {
      queryText: "needle", interpretationClock: "2026-09-06T00:00:00.000Z",
      since: "2020-01-01T00:00:00.000Z", until: "2026-09-06T00:00:00.000Z",
      timeFilter: { field: "last_used_at" as const }, budget, cancelled: true, continuation: null,
      cap_contracts: [HARD_IDENTITY_CAP_CONTRACT]
    };
    await invokeBoundRecall({
      sideEffectMode: "benchmark", recallService: { recall }, taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", policyOverride: makeSharedPolicy(), ...options
    });
    expect(recall).toHaveBeenCalledWith(expect.objectContaining(options));
    expect(recall.mock.calls[0]?.[0].budget).toBe(budget);
  });

  it("ignores sideEffectMode and does not set defer_delivery", async () => {
    const recall = vi.fn(async (_params: BoundRecallInvokeParams) => "result");
    const shared = {
      recallService: { recall },
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      policyOverride: makeSharedPolicy()
    };
    await invokeBoundRecall({ sideEffectMode: "benchmark", ...shared });
    await invokeBoundRecall({ sideEffectMode: "production_mcp", ...shared });
    expect(recall).toHaveBeenCalledTimes(2);
    const [benchmarkCall, productionLabelCall] = recall.mock.calls.map(([params]) => params);
    expect(benchmarkCall).not.toHaveProperty("sideEffectMode");
    expect(benchmarkCall).not.toHaveProperty("defer_delivery");
    expect(productionLabelCall).toEqual(benchmarkCall);
  });

  it("keeps production MCP defer_delivery distinct from this wrapper's forwarded fields", async () => {
    const policy = makeSharedPolicy();
    const taskSurface = makeTaskSurface(policy);
    const recallService = {
      recall: vi.fn(async () => buildSeededRecallResult())
    };
    await runProductionBoundRecall({
      deps: { recallService } as unknown as RecallUsageHandlerDependencies,
      request: makeSearchRequest(),
      context: {
        workspaceId: "ws-forward",
        runId: "run-forward",
        agentTarget: "codex",
        sessionId: "session-forward"
      },
      taskSurface,
      policyOverride: policy
    });
    await invokeBoundRecall({
      sideEffectMode: "benchmark",
      recallService,
      taskSurface,
      workspaceId: "ws-forward",
      runId: "run-forward",
      strategy: "chat",
      policyOverride: policy,
      activeConstraintsCap: null
    });
    expect(recallService.recall).toHaveBeenCalledTimes(2);
    const [mcpCall, benchCall] = (recallService.recall as ReturnType<typeof vi.fn>).mock.calls.map(
      ([params]) => params as Record<string, unknown>
    );
    if (mcpCall === undefined || benchCall === undefined) {
      throw new Error("Expected both production MCP and benchmark recall calls");
    }
    expect(mcpCall.defer_delivery).toBe(true);
    expect(benchCall).not.toHaveProperty("defer_delivery");
    const sharedIdentity = (call: Record<string, unknown>) => ({
      workspaceId: call.workspaceId,
      policyOverride: call.policyOverride,
      strategy: call.strategy,
      runId: call.runId
    });
    expect(sharedIdentity(mcpCall)).toEqual({
      workspaceId: "ws-forward",
      policyOverride: policy,
      strategy: "chat",
      runId: "run-forward"
    });
    expect(sharedIdentity(mcpCall)).toEqual(sharedIdentity(benchCall));
  });

  it("forwards snapshotDigest only when the caller supplies it", async () => {
    const policy = makeSharedPolicy();
    const taskSurface = makeTaskSurface(policy);
    const recallService = {
      recall: vi.fn(async () => buildSeededRecallResult())
    };
    const snapshotDigest = `sha256:${"b".repeat(64)}`;
    await invokeBoundRecall({
      sideEffectMode: "benchmark",
      recallService,
      taskSurface,
      workspaceId: "ws-snapshot",
      policyOverride: policy,
      snapshotDigest
    });
    expect(recallService.recall).toHaveBeenCalledWith(expect.objectContaining({ snapshotDigest }));
    await runProductionBoundRecall({
      deps: { recallService } as unknown as RecallUsageHandlerDependencies,
      request: makeSearchRequest(),
      context: {
        workspaceId: "ws-snapshot",
        runId: null,
        agentTarget: "codex",
        sessionId: "s"
      },
      taskSurface,
      policyOverride: policy
    });
    const productionCall = (recallService.recall as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      { readonly snapshotDigest?: string };
    expect(productionCall).not.toHaveProperty("snapshotDigest");
  });

  it("does not default MCP time_field to created_at when since/until omit it", async () => {
    const policy = makeSharedPolicy();
    const taskSurface = makeTaskSurface(policy);
    const recallService = {
      recall: vi.fn(async () => buildSeededRecallResult())
    };
    await runProductionBoundRecall({
      deps: { recallService } as unknown as RecallUsageHandlerDependencies,
      request: makeSearchRequest({
        since: "2026-09-05T00:00:00.000Z",
        until: "2026-09-06T00:00:00.000Z"
      }),
      context: {
        workspaceId: "ws-time",
        runId: null,
        agentTarget: "codex",
        sessionId: "s"
      },
      taskSurface,
      policyOverride: policy
    });
    const productionCall = (recallService.recall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      readonly since?: string;
      readonly timeFilter?: { readonly field?: string };
    };
    expect(productionCall.since).toBe("2026-09-05T00:00:00.000Z");
    expect(productionCall.timeFilter?.field).not.toBe("created_at");
  });
});

function buildSeededRecallResult() {
  return Object.freeze({
    candidates: Object.freeze([
      Object.freeze({
        object_id: "mem-a",
        content_preview: "alpha deployment rules",
        relevance_score: 2,
        object_kind: "memory_entry",
        activation_score: 0.8,
        token_estimate: 10
      }),
      Object.freeze({
        object_id: "mem-b",
        content_preview: "beta deployment",
        relevance_score: 1,
        object_kind: "memory_entry",
        activation_score: 0.7,
        token_estimate: 10
      })
    ]),
    active_constraints: Object.freeze([]),
    active_constraints_count: 0,
    total_scanned: 2,
    coarse_filter_count: 2,
    fine_assessment_count: 2,
    diagnostics: Object.freeze({
      scoring_weight_overrides: Object.freeze({
        fusion_weights: Object.freeze({ embedding_similarity: 1 })
      })
    })
  });
}
