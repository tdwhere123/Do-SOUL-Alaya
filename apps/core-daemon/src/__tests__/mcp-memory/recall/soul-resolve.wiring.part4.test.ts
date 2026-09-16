import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  ObjectLifecycleState,
  SoulResolutionKind
} from "@do-soul/alaya-protocol";
import {
  FIXED_NOW,
  buildClaim,
  buildMemory,
  context,
  createHarness
} from "./soul-resolve.wiring-harness.js";

describe("soul.resolve handler fixture wiring", () => {

  it("not_relevant path: emits the dismissal event without lifecycle changes", async () => {
    const harness = createHarness();
    harness.memories.set("mem-1", buildMemory({ lifecycle_state: ObjectLifecycleState.ACTIVE }));
    harness.deliveries.set("delivery-5", {
      delivery_id: "delivery-5",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["mem-1"],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-5"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "mem-1",
        resolution: SoulResolutionKind.NOT_RELEVANT,
        delivery_id: "delivery-5"
      },
      context
    });
    expect(result.ok).toBe(true);
    expect(harness.memories.get("mem-1")?.lifecycle_state).toBe(ObjectLifecycleState.ACTIVE);
    expect(
      harness.events.some(
        (e) =>
          e.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_NOT_RELEVANT_APPLIED
      )
    ).toBe(true);
  });

  it("scope check: rejects soul.resolve when delivery_id does not belong to the calling agent", async () => {
    const harness = createHarness();
    harness.claims.set("claim-1", buildClaim({ object_id: "claim-1" }));
    harness.deliveries.set("foreign-delivery", {
      delivery_id: "foreign-delivery",
      agent_target: "other-agent",
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["claim-1"],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-x"
    });
    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-1",
        resolution: SoulResolutionKind.CONFIRM,
        delivery_id: "foreign-delivery"
      },
      context
    });
    expect(result.ok).toBe(false);
  });
});
