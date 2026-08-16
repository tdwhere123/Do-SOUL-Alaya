import { describe, expect, it, vi } from "vitest";
import {
  createRecallHandler,
  createReportContextUsageHandler,
  type RecallUsageHandlerDependencies
} from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { InMemoryCausalUsageRecorder } from "../../../mcp-memory/usage/causal-usage-recorder.js";
import { hashUsageIdentity } from "../../../mcp-memory/usage/causal-usage-identity.js";
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

  it("records one causal receipt per used object and replays the same identity", async () => {
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

    const receipts = recorder.list();
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.usage_kind === "causal")).toBe(true);
    expect(receipts.every((receipt) => receipt.weight === 1)).toBe(true);
    expect(receipts.map((receipt) => receipt.downstream_ref).sort()).toEqual(["mem1", "mem2"]);
    expect(receipts[0]?.identity).toBe(hashUsageIdentity({
      causal_key: "delivery_1:mem1",
      downstream_ref: "mem1",
      scope: context.workspaceId
    }));
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

    expect(recorder.list().map((receipt) => receipt.downstream_ref)).toEqual(["mem1"]);
    expect(recorder.list().some((receipt) => receipt.downstream_ref === "mem2")).toBe(false);
    expect(recorder.list().some((receipt) => receipt.downstream_ref === "mem3")).toBe(false);
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
