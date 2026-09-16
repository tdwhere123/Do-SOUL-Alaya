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

  it("reject path: archives a non-draft claim and emits the reject audit event", async () => {
    const harness = createHarness();
    harness.claims.set(
      "claim-1",
      buildClaim({ object_id: "claim-1", claim_status: ClaimLifecycleState.ACTIVE })
    );
    harness.deliveries.set("delivery-1", {
      delivery_id: "delivery-1",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["claim-1"],
      delivered_objects: [{ object_id: "claim-1", object_kind: "claim_form" }],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-1"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-1",
        resolution: SoulResolutionKind.REJECT,
        delivery_id: "delivery-1"
      },
      context
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(harness.claims.get("claim-1")?.claim_status).toBe(ClaimLifecycleState.ARCHIVED);
    expect(
      harness.events.some(
        (event) =>
          event.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED
      )
    ).toBe(true);
  });

  it("correct path: emits the audit event with the corrected proposition", async () => {
    const harness = createHarness();
    const correction = "the build command is `make ci`";
    harness.memories.set("mem-1", buildMemory());
    harness.deliveries.set("delivery-2", {
      delivery_id: "delivery-2",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["mem-1"],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-2"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "mem-1",
        resolution: SoulResolutionKind.CORRECT,
        delivery_id: "delivery-2",
        correction
      },
      context
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const event = harness.events.find(
      (e) => e.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED
    );
    expect(event?.payload_json).toMatchObject({
      correction,
      predecessor_receipt_id: expect.any(String),
      successor_receipt_id: expect.any(String)
    });
    expect(harness.claims.size).toBe(0);
    expect(harness.memories.get("mem-1")?.lifecycle_state).toBe(ObjectLifecycleState.ACTIVE);
  });
});
