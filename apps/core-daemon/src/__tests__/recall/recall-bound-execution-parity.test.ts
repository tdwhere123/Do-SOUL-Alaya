import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema,
  type RecallPolicy,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import { buildRecallPolicy } from "@do-soul/alaya-core";
import { runProductionBoundRecall } from "../../mcp-memory/recall-bound-service.js";
import type { RecallUsageHandlerDependencies } from "../../mcp-memory/recall-usage-handlers.js";
import { invokeBoundRecall } from "../../recall/recall-bound-execution.js";

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

describe("invokeBoundRecall shared input contract", () => {
  it("keeps production_mcp and benchmark wrappers on the same recall-service inputs", async () => {
    const policy = makeSharedPolicy();
    const taskSurfaceId = policy.task_surface_ref;
    const taskSurface = TaskObjectSurfaceSchema.parse({
      runtime_id: taskSurfaceId,
      object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      task_surface_ref: null,
      expires_at: null,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      surface_kind: "mcp_memory_tool",
      display_name: "deployment rules",
      context_refs: []
    });
    const recallService = {
      recall: vi.fn(async (params: { readonly taskSurface: { readonly display_name: string } }) =>
        buildSeededRecallResult(params.taskSurface.display_name)
      )
    };
    const request: SoulMemorySearchRequest = {
      query: "deployment rules",
      max_results: 5,
      scope_class: null,
      dimension: null,
      domain_tags: null
    };

    const mcpResult = await runProductionBoundRecall({
      deps: { recallService } as unknown as RecallUsageHandlerDependencies,
      request,
      context: {
        workspaceId: "ws-parity",
        runId: "run-parity",
        agentTarget: "codex",
        sessionId: "session-parity"
      },
      taskSurface,
      policyOverride: policy
    });
    const benchResult = await invokeBoundRecall({
      sideEffectMode: "benchmark",
      recallService,
      taskSurface,
      workspaceId: "ws-parity",
      runId: "run-parity",
      strategy: "chat",
      policyOverride: policy,
      activeConstraintsCap: null
    });

    expect(mcpResult.candidates.map((candidate) => candidate.object_id)).toEqual([
      "mem-a",
      "mem-b"
    ]);
    expect(benchResult.candidates.map((candidate) => candidate.object_id)).toEqual([
      "mem-a",
      "mem-b"
    ]);
    expect(recallService.recall).toHaveBeenCalledTimes(2);
    const [mcpCall, benchCall] = (recallService.recall as ReturnType<typeof vi.fn>).mock.calls.map(
      ([params]) => params
    );
    expect(mcpCall).toMatchObject({ workspaceId: "ws-parity", policyOverride: policy });
    expect(benchCall).toMatchObject({ workspaceId: "ws-parity", policyOverride: policy });
    // This is a wrapper contract check, not a full MCP/bench surface parity
    // claim. Delivery shaping and materialized benchmark state have separate
    // integration coverage.
    expect({ ...mcpCall, taskSurface: undefined }).toEqual({
      ...benchCall,
      taskSurface: undefined
    });
  });
});

function buildSeededRecallResult(query: string) {
  const seed = [
    {
      object_id: "mem-b",
      content_preview: "beta deployment",
      relevance_score: score(query, "beta deployment")
    },
    {
      object_id: "mem-a",
      content_preview: "alpha deployment rules",
      relevance_score: score(query, "alpha deployment rules")
    },
    { object_id: "mem-c", content_preview: "unrelated", relevance_score: score(query, "unrelated") }
  ];
  const candidates = seed
    .sort((left, right) => right.relevance_score - left.relevance_score)
    .slice(0, 2)
    .map((candidate, index) =>
      Object.freeze({
        ...candidate,
        object_kind: "memory_entry",
        activation_score: 0.8 - index / 10,
        token_estimate: 10
      })
    );
  return Object.freeze({
    candidates: Object.freeze(candidates),
    active_constraints: Object.freeze([]),
    active_constraints_count: 0,
    total_scanned: seed.length,
    coarse_filter_count: seed.length,
    fine_assessment_count: candidates.length,
    diagnostics: Object.freeze({
      scoring_weight_overrides: Object.freeze({
        fusion_weights: Object.freeze({ embedding_similarity: 1 })
      })
    })
  });
}

function score(query: string, content: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/);
  return queryTerms.filter((term) => content.includes(term)).length;
}
