import { describe, expect, it, vi } from "vitest";
import {
  createRecallHandler,
  createReportContextUsageHandler,
  type RecallUsageHandlerDependencies
} from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { InMemoryCausalUsageRecorder } from "../../../mcp-memory/usage/causal-usage-recorder.js";
import {
  context,
  createDeliveryRecord,
  createDeps
} from "../tool/mcp-memory-tool-handler-fixture.js";

const NOW = "2026-04-30T00:00:00.000Z";

describe("recall usage causal receipts", () => {
  it("does not record learning receipts for delivered-but-unused context", async () => {
    const recorder = new InMemoryCausalUsageRecorder();
    const onCoRecall = vi.fn(async () => undefined);
    const deps = {
      ...createDeps(),
      causalUsagePort: recorder,
      pathRelationProposalService: {
        onCoRecall,
        onCoUsage: vi.fn(async () => undefined)
      }
    } as RecallUsageHandlerDependencies;
    const recall = createRecallHandler({
      deps,
      now: () => NOW,
      warn: vi.fn(),
      generateId: () => "00000000-0000-4000-8000-000000000001"
    });

    await recall({
      query: "what are the deployment rules",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5
    }, context);

    expect(recorder.list()).toEqual([]);
    expect(onCoRecall).not.toHaveBeenCalled();
  });

  it("treats a used self-report as telemetry and does not mint causal receipts", async () => {
    const recorder = new InMemoryCausalUsageRecorder();
    const deps = withDelivery(recorder, ["mem1", "mem2"]);
    const report = createReportContextUsageHandler({
      deps,
      now: () => NOW,
      warn: vi.fn()
    });

    await report({
      delivery_id: "delivery_1",
      usage_state: "used",
      used_object_ids: ["mem1", "mem2"],
      reason: "cited"
    }, context);
    await report({
      delivery_id: "delivery_1",
      usage_state: "used",
      used_object_ids: ["mem1", "mem2"],
      reason: "cited again"
    }, context);

    expect(recorder.list()).toEqual([]);
  });

  it("does not assign top-k membership credit to unused delivered ids", async () => {
    const recorder = new InMemoryCausalUsageRecorder();
    const deps = withDelivery(recorder, ["mem1", "mem2", "mem3"]);
    const report = createReportContextUsageHandler({
      deps,
      now: () => NOW,
      warn: vi.fn()
    });

    await report({
      delivery_id: "delivery_1",
      usage_state: "used",
      used_object_ids: ["mem1"],
      reason: "one citation"
    }, context);

    expect(recorder.list()).toEqual([]);
  });

  it("binds telemetry reports to workspace, agent, and the session-backed run", async () => {
    const recorder = new InMemoryCausalUsageRecorder();
    const deps = withDelivery(recorder, ["mem1"]);
    const report = createReportContextUsageHandler({ deps, now: () => NOW, warn: vi.fn() });

    await report({
      delivery_id: "delivery_1",
      usage_state: "used",
      used_object_ids: ["mem1"],
      reason: null
    }, { ...context, runId: null, sessionId: "session-1" });

    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.any(Object),
      {
        expectedWorkspaceId: context.workspaceId,
        expectedAgentTarget: context.agentTarget,
        expectedRunId: "session-1"
      }
    );
  });
});

function withDelivery(
  recorder: InMemoryCausalUsageRecorder,
  deliveredObjectIds: readonly string[]
): RecallUsageHandlerDependencies {
  const deps = createDeps();
  deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) => ({
    ...createDeliveryRecord(deliveryId),
    delivered_object_ids: [...deliveredObjectIds]
  }));
  return {
    ...deps,
    causalUsagePort: recorder
  } as RecallUsageHandlerDependencies;
}
