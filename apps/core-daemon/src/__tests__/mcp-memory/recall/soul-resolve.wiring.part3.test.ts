import { describe, expect, it } from "vitest";
import {
  GovernanceResolutionEventType,
  ObjectLifecycleState,
  SoulResolutionKind,
  FIXED_NOW,
  buildClaim,
  buildMemory,
  context,
  createHarness
} from "./soul-resolve.wiring-harness.js";

describe("soul.resolve handler fixture wiring", () => {

  it("stale path: transitions a memory_entry active -> dormant", async () => {
    const harness = createHarness();
    harness.memories.set("mem-1", buildMemory({ lifecycle_state: ObjectLifecycleState.ACTIVE }));
    harness.deliveries.set("delivery-3", {
      delivery_id: "delivery-3",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["mem-1"],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-3"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "mem-1",
        resolution: SoulResolutionKind.STALE,
        delivery_id: "delivery-3"
      },
      context
    });
    expect(result.ok).toBe(true);
    expect(harness.memories.get("mem-1")?.lifecycle_state).toBe(ObjectLifecycleState.DORMANT);
    expect(
      harness.events.some(
        (e) => e.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED
      )
    ).toBe(true);
  });

  it("defer path: creates a DeferredObligation and emits the defer audit event", async () => {
    const harness = createHarness();
    harness.claims.set("claim-1", buildClaim({ object_id: "claim-1" }));
    harness.deliveries.set("delivery-4", {
      delivery_id: "delivery-4",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["claim-1"],
      delivered_objects: [{ object_id: "claim-1", object_kind: "claim_form" }],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-4"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-1",
        resolution: SoulResolutionKind.DEFER,
        delivery_id: "delivery-4",
        defer_until: "2026-05-18T00:00:00.000Z",
        reason: "agent needs supporting evidence"
      },
      context
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.output as {
      readonly status: string;
      readonly obligation_id?: string;
    };
    expect(output.status).toBe("deferred");
    expect(output.obligation_id).toBe("obligation-1");
    expect(harness.obligations.get("obligation-1")?.kind).toBe("evidence_refresh");
    expect(
      harness.events.some(
        (e) => e.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_DEFER_APPLIED
      )
    ).toBe(true);
  });
});
