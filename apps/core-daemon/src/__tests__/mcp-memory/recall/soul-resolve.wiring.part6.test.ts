import { describe, expect, it } from "vitest";
import {
  GovernanceResolutionEventType,
  ObjectLifecycleState,
  SoulResolutionKind,
  FIXED_NOW,
  buildMemory,
  context,
  createHarness
} from "./soul-resolve.wiring-harness.js";

describe("soul.resolve handler fixture wiring", () => {

  it("scope check: rejects memory resolution when delivery only carried a same-id synthesis capsule", async () => {
    const harness = createHarness();
    harness.memories.set(
      "shared-object",
      buildMemory({
        object_id: "shared-object",
        lifecycle_state: ObjectLifecycleState.ACTIVE
      })
    );
    harness.deliveries.set("delivery-synthesis-only", {
      delivery_id: "delivery-synthesis-only",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["shared-object"],
      delivered_objects: [
        { object_id: "shared-object", object_kind: "synthesis_capsule" }
      ],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-synthesis-only"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "shared-object",
        resolution: SoulResolutionKind.STALE,
        delivery_id: "delivery-synthesis-only"
      },
      context
    });

    expect(result.ok).toBe(false);
    expect(harness.memories.get("shared-object")?.lifecycle_state).toBe(ObjectLifecycleState.ACTIVE);
    expect(
      harness.events.some(
        (event) => event.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED
      )
    ).toBe(false);
  });
});
