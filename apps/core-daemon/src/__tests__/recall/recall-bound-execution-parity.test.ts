import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  TaskObjectSurfaceSchema,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { buildRecallPolicy } from "@do-soul/alaya-core";
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

describe("invokeBoundRecall parity", () => {
  it("returns identical top-K for production_mcp and benchmark modes", async () => {
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
    const recallResult = Object.freeze({
      candidates: Object.freeze([
        Object.freeze({
          object_id: "mem-a",
          object_kind: "memory_entry",
          relevance_score: 0.9,
          activation_score: 0.8,
          token_estimate: 10,
          content_preview: "alpha"
        }),
        Object.freeze({
          object_id: "mem-b",
          object_kind: "memory_entry",
          relevance_score: 0.8,
          activation_score: 0.7,
          token_estimate: 10,
          content_preview: "beta"
        })
      ]),
      active_constraints: Object.freeze([]),
      active_constraints_count: 0,
      total_scanned: 2,
      coarse_filter_count: 2,
      fine_assessment_count: 2,
      diagnostics: Object.freeze({
        scoring_weight_overrides: Object.freeze({
          fusion_weights: Object.freeze({ embedding_similarity: 12 })
        })
      })
    });
    const recallService = {
      recall: vi.fn(async () => recallResult)
    };

    const sharedParams = {
      recallService,
      taskSurface,
      workspaceId: "ws-parity",
      runId: "run-parity",
      policyOverride: policy
    } as const;

    const mcpResult = await invokeBoundRecall({
      ...sharedParams,
      sideEffectMode: "production_mcp"
    });
    const benchResult = await invokeBoundRecall({
      ...sharedParams,
      sideEffectMode: "benchmark"
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
    expect(recallService.recall.mock.calls[0]?.[0]).toEqual(recallService.recall.mock.calls[1]?.[0]);
  });
});
