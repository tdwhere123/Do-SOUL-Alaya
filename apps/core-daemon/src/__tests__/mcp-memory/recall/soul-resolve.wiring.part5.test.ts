import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  GovernanceResolutionEventType,
  SoulResolutionKind,
  FIXED_NOW,
  buildClaim,
  context,
  createHarness
} from "./soul-resolve.wiring-harness.js";

describe("soul.resolve handler fixture wiring", () => {

  // invariant: a valid in-scope delivery_id MUST NOT authorise mutating
  // a target_object_id that was not in that delivery's
  // delivered_object_ids — the resolve handler rejects scope-confusion
  // attempts even when every other check passes.
  it("scope check: rejects soul.resolve when target_object_id is not in the delivery", async () => {
    const harness = createHarness();
    harness.claims.set(
      "claim-other",
      buildClaim({ object_id: "claim-other", claim_status: ClaimLifecycleState.DRAFT })
    );
    harness.deliveries.set("delivery-scoped", {
      delivery_id: "delivery-scoped",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["claim-1"],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-scoped"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-other",
        resolution: SoulResolutionKind.CONFIRM,
        delivery_id: "delivery-scoped"
      },
      context
    });

    expect(result.ok).toBe(false);
    expect(harness.claims.get("claim-other")?.claim_status).toBe(ClaimLifecycleState.DRAFT);
    expect(
      harness.events.some(
        (event) => event.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
      )
    ).toBe(false);
  });
});
