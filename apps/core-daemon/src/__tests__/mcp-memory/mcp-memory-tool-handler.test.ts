import { describe, expect, it, vi } from "vitest";

import {
  MemoryDimension,
  ScopeClass,
} from "@do-soul/alaya-protocol";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

import {
  context,
  createActiveConstraint,
  createDeliveryRecord,
  createDeps,
  createMemory,
  createRecallCandidate
} from "./mcp-memory-tool-handler-fixture.js";

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
        delivered_object_ids: ["mem1"],
        delivered_objects: [{ object_id: "mem1", object_kind: "memory_entry" }]
      })
    );
    expect(result.ok && result.output).toMatchObject({
      delivery_id: "delivery_00000000-0000-4000-8000-000000000003",
      total_count: 1,
      degradation_reason: "recall_explainability_partial"
    });
  });

  it("returns active constraints outside results and dedupes overlapping ids from results", async () => {
    const deps = createDeps();
    deps.recallService.recall = vi.fn(async () => ({
      candidates: [
        createRecallCandidate({ object_id: "mem1", content_preview: "rule also active" }),
        createRecallCandidate({ object_id: "mem2", content_preview: "semantic result" })
      ],
      active_constraints: [
        createActiveConstraint({ object_id: "mem1", content: "rule also active" }),
        createActiveConstraint({ object_id: "constraint-2", content: "second active rule" })
      ],
      active_constraints_count: 2,
      total_scanned: 2,
      coarse_filter_count: 2,
      fine_assessment_count: 2
    })) as typeof deps.recallService.recall;
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 10,
        active_constraints_cap: 5
      },
      context
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(deps.recallService.recall).toHaveBeenCalledWith(expect.objectContaining({
      activeConstraintsCap: 5
    }));
    const output = result.output as {
      readonly results: ReadonlyArray<{ readonly object_id: string }>;
      readonly active_constraints: ReadonlyArray<{ readonly object_id: string }>;
      readonly active_constraints_count: number;
    };
    expect(output.results.map((entry) => entry.object_id)).toEqual(["mem2"]);
    expect(output.active_constraints.map((entry) => entry.object_id)).toEqual([
      "mem1",
      "constraint-2"
    ]);
    expect(output.active_constraints_count).toBe(2);
    expect(deps.trustStateRecorder.recordDelivery).toHaveBeenCalledWith(expect.objectContaining({
      delivered_object_ids: ["mem2", "mem1", "constraint-2"],
      delivered_objects: [
        { object_id: "mem2", object_kind: "memory_entry" },
        { object_id: "mem1", object_kind: "memory_entry" },
        { object_id: "constraint-2", object_kind: "memory_entry" }
      ]
    }));
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

  it("widens the coarse candidate pool without widening the delivered result count", async () => {
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
    expect(callArg?.policyOverride?.coarse_filter.precomputed_rank.max_candidates).toBe(30);
    expect(callArg?.policyOverride?.fine_assessment.budgets.max_entries).toBe(3);
    expect(callArg?.policyOverride?.coarse_filter.semantic_supplement.max_supplement).toBe(30);
    expect(callArg?.policyOverride?.coarse_filter.semantic_supplement.embedding_enabled).toBe(true);
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
          tokenizer_hint: "cl100k"
        }
      },
      context
    });

    expect(deps.recallService.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        hostContext: {
          tokenizer_hint: "cl100k"
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

  it("forwards staged_warnings from recall candidates onto the public result", async () => {
    const deps = createDeps();
    deps.recallService.recall = vi.fn(async () => ({
      candidates: [
        {
          object_id: "mem1",
          object_kind: "memory_entry" as const,
          activation_score: 0.9,
          relevance_score: 0.8,
          content_preview: "deployment rules",
          token_estimate: 12,
          manifestation: "excerpt" as const,
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          origin_plane: "workspace_local" as const,
          staged_warnings: [
            {
              kind: "contradiction_pending" as const,
              severity: "blocking" as const,
              policy: "conflict_detection.v1",
              summary: "Contradicts memory-42.",
              resolution_options: ["accept_pending", "reject_pending", "escalate_human"] as const
            }
          ]
        }
      ],
      active_constraints: [],
      active_constraints_count: 0,
      total_scanned: 1,
      coarse_filter_count: 1,
      fine_assessment_count: 1
    })) as typeof deps.recallService.recall;
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
    if (!result.ok) {
      return;
    }
    const output = result.output as { readonly results: ReadonlyArray<Record<string, unknown>> };
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      object_id: "mem1",
      staged_warnings: [
        {
          kind: "contradiction_pending",
          severity: "blocking",
          policy: "conflict_detection.v1",
          target_object_id: "mem1",
          resolution_options: ["accept_pending", "reject_pending", "escalate_human"]
        }
      ]
    });
  });

  it("forwards manifestation sidecar fields onto the public recall result", async () => {
    const deps = createDeps();
    deps.recallService.recall = vi.fn(async () => ({
      candidates: [
        {
          object_id: "mem1",
          object_kind: "memory_entry" as const,
          activation_score: 0.9,
          relevance_score: 0.8,
          content_preview: "unfinished migration checklist",
          token_estimate: 12,
          manifestation: "excerpt" as const,
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          origin_plane: "workspace_local" as const,
          pending_incomplete: true,
          unfinishedness_bias: 0.65
        }
      ],
      active_constraints: [],
      active_constraints_count: 0,
      total_scanned: 1,
      coarse_filter_count: 1,
      fine_assessment_count: 1
    })) as typeof deps.recallService.recall;
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "unfinished migration checklist",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = result.output as { readonly results: ReadonlyArray<Record<string, unknown>> };
    expect(output.results[0]).toMatchObject({
      object_id: "mem1",
      pending_incomplete: true,
      unfinishedness_bias: 0.65
    });
  });

  it("omits staged_warnings on the public result when the recall candidate has none", async () => {
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
    if (!result.ok) {
      return;
    }
    const output = result.output as { readonly results: ReadonlyArray<Record<string, unknown>> };
    expect(output.results[0]?.staged_warnings).toBeUndefined();
  });
});
