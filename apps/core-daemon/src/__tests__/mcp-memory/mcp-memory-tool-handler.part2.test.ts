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
      active_constraints: [],
      active_constraints_count: 0,
      total_scanned: 1,
      coarse_filter_count: 1,
      fine_assessment_count: 1,
      degradation_reason: "cold_cascade_engaged"
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

  it("falls through to evidence capsule when memory lookup misses, returning gist and excerpt", async () => {
    const deps = createDeps();
    deps.memoryService.findByIdScoped = vi.fn(async () => null);
    const findEvidence = vi.fn(async (objectId: string, _workspaceId: string) => ({
      object_id: objectId,
      object_kind: "evidence_capsule",
      schema_version: 1,
      gist: "distilled fact gist",
      excerpt: "raw turn excerpt material the agent should see when opening a pointer"
    }));
    const depsWithEvidence = {
      ...deps,
      evidenceService: { findByIdScoped: findEvidence }
    };
    const handler = createMcpMemoryToolHandler(depsWithEvidence);

    const result = await handler.call({
      toolName: "soul.open_pointer",
      arguments: { object_id: "evidence-1" },
      context
    });

    expect(result.ok).toBe(true);
    expect(findEvidence).toHaveBeenCalledWith("evidence-1", context.workspaceId);
    expect(result.ok && result.output).toMatchObject({
      object_id: "evidence-1",
      object_kind: "evidence_capsule",
      content: {
        object_id: "evidence-1",
        object_kind: "evidence_capsule",
        gist: "distilled fact gist",
        excerpt: "raw turn excerpt material the agent should see when opening a pointer"
      }
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
      // The handler passes the call-context workspace as an
      // expected-workspace guard so cross-workspace report_context_usage
      // is rejected at the trust-state layer before any
      // MEMORY_USAGE_REPORTED row is appended.
      { expectedWorkspaceId: context.workspaceId }
    );
  });

  it("rejects caller-supplied trust_mode so the server derives usage trust", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        // A caller tries to claim full path-plasticity weight by sending
        // trust_mode=manual. The strict public request schema rejects that
        // field; only the server writes UsageProofRecord.trust_mode.
        trust_mode: "manual",
        reason: "cited"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION"
      }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it("feeds co-usage path reinforcement only when the report has a resolvable delivery", async () => {
    // SECURITY: co-usage reinforcement (onCoUsage) requires a server-side
    // delivery witness. A report whose delivery cannot be resolved skips the
    // delivered_object_ids subset gate, so feeding its used ids into onCoUsage
    // would let a caller pump path support/strength between arbitrary memories.
    // A legitimate report (delivery resolves, used ids subset the delivery)
    // still reinforces. see also: mcp-memory/tool-handler.ts reportContextUsage.
    const onCoUsage = vi.fn(async () => undefined);
    const onCoRecall = vi.fn(async () => undefined);
    const baseDeps = createDeps();
    const deps: McpMemoryToolHandlerDependencies = {
      ...baseDeps,
      pathRelationProposalService: { onCoUsage, onCoRecall }
    };
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) => ({
      ...createDeliveryRecord(deliveryId),
      delivered_object_ids: ["mem1", "mem2"]
    }));
    const handler = createMcpMemoryToolHandler(deps);

    const legitimate = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1", "mem2"],
        reason: "both cited"
      },
      context
    });
    expect(legitimate.ok).toBe(true);
    expect(onCoUsage).toHaveBeenCalledTimes(1);
    expect(onCoUsage).toHaveBeenCalledWith(["mem1", "mem2"], context.workspaceId);

    onCoUsage.mockClear();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () => null);
    const unresolved = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_unknown",
        usage_state: "used",
        used_object_ids: ["mem1", "mem2"],
        reason: "no resolvable delivery"
      },
      context
    });
    expect(unresolved.ok).toBe(true);
    expect(onCoUsage).not.toHaveBeenCalled();
  });

  it("uses delivered_objects as the canonical used object list", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          { object_id: "mem1", usage_status: "used" },
          { object_id: "mem2", usage_status: "skipped" }
        ],
        reason: "cited from delivered object status"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        reason: "cited from delivered object status"
      }),
      { expectedWorkspaceId: context.workspaceId }
    );
    expect(deps.memoryService.findByIdsScoped).toHaveBeenCalledWith(["mem1"], "ws1");
    expect(deps.memoryService.findByIdScoped).not.toHaveBeenCalledWith("mem2", "ws1");
    expect(deps.memoryService.updateScoped).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.updateScoped).toHaveBeenCalledWith(
      "mem1",
      "ws1",
      expect.objectContaining({
        storage_tier: "hot",
        last_used_at: "2026-04-30T00:00:00.000Z",
        last_hit_at: "2026-04-30T00:00:00.000Z"
      }),
      "recall_usage_reported"
    );
  });

  it("does not promote memory usage from a used synthesis_capsule with the same object_id", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          { object_id: "mem1", object_kind: "synthesis_capsule", usage_status: "used" }
        ],
        reason: "synthesis was useful"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: []
      }),
      { expectedWorkspaceId: context.workspaceId }
    );
    expect(deps.memoryService.findByIdScoped).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("rejects report_context_usage when aggregate usage_state contradicts delivered_objects", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          { object_id: "mem1", usage_status: "skipped" }
        ],
        reason: "contradictory proof"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("rejects report_context_usage when used_object_ids contradict delivered_objects", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem2"],
        delivered_objects: [
          { object_id: "mem1", usage_status: "used" }
        ],
        reason: "contradictory ids"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("rejects report_context_usage when a used id was not part of the linked delivery", async () => {
    // SECURITY: the linked delivery carries only mem1; a caller reporting mem2
    // (never delivered) would fabricate co-usage between mem1 and a memory it
    // was never served. The server-side delivered_object_ids gate rejects it
    // even when no spoofable delivered_objects array is supplied.
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) => ({
      ...createDeliveryRecord(deliveryId),
      delivered_object_ids: ["mem1"]
    }));
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1", "mem2"],
        reason: "fabricated co-usage"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });
});
