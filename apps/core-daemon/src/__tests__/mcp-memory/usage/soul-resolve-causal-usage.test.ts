import { describe, expect, it, vi } from "vitest";
import { SoulResolutionKind } from "@do-soul/alaya-protocol";
import { createSoulResolveHandler } from "../../../mcp-memory/tool/resolve-handler.js";

const context = {
  workspaceId: "workspace-1",
  runId: "run-1",
  agentTarget: "agent-1",
  sessionId: "session-1"
} as const;

describe("soul.resolve causal usage", () => {
  it("requires the configured reviewer identity and token before resolution", async () => {
    const resolve = vi.fn(async () => ({
      resolution: SoulResolutionKind.CONFIRM,
      status: "applied" as const,
      auditEventType: "soul.governance.resolution.confirmed",
      auditEventId: "resolution-event-1",
      activatedClaimId: "claim-1",
      effectDecision: "allow" as const
    }));
    const handler = createSoulResolveHandler({
      resolutionService: { resolve },
      trustStateRecorder: { findDeliveryById: async () => delivery() },
      claimSourceReader: { findSourceObjectRefs: async () => ["memory-1"] },
      reviewerIdentityBinding: { identity: "reviewer-1", token: "review-token" }
    });

    for (const credentials of [
      {},
      { reviewer_identity: "reviewer-1" },
      { reviewer_identity: "reviewer-1", reviewer_token: "wrong" },
      { reviewer_identity: "other", reviewer_token: "review-token" }
    ]) {
      await expect(handler.resolve({ ...request(), ...credentials }, context)).rejects.toThrow();
    }
    expect(resolve).not.toHaveBeenCalled();
    await handler.resolve({ ...request(), reviewer_identity: "reviewer-1", reviewer_token: "review-token" }, context);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      agentTarget: "agent-1",
      reviewerIdentity: "reviewer-1"
    }));
  });

  it("records delivered source usage only after a successful trusted resolution", async () => {
    const record = vi.fn(async () => undefined);
    const resolve = vi.fn(async () => ({
      resolution: SoulResolutionKind.CONFIRM,
      status: "applied" as const,
      auditEventType: "soul.governance.resolution.confirmed" as const,
      auditEventId: "resolution-event-1",
      activatedClaimId: "claim-1",
      effectDecision: "allow" as const
    }));
    const handler = createSoulResolveHandler({
      resolutionService: { resolve },
      trustStateRecorder: { findDeliveryById: async () => delivery() },
      claimSourceReader: { findSourceObjectRefs: async () => ["memory-1", "not-delivered"] },
      causalUsageRecorder: { record },
      now: () => "2026-08-17T00:00:00.000Z"
    });

    await expect(handler.resolve(request(), context)).resolves.toMatchObject({ usage_recording_status: "recorded" });

    expect(record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      causalKey: "resolution-event-1",
      usedObjectIds: ["memory-1"],
      occurredAt: "2026-08-17T00:00:00.000Z",
      scope: "workspace-1",
      runId: "run-1",
      causedBy: "agent-1"
    });
  });

  it("reports committed confirmation even if cancellation and usage failure follow", async () => {
    const abort = new AbortController();
    const handler = createSoulResolveHandler({
      resolutionService: { resolve: async () => {
        abort.abort();
        return { resolution: SoulResolutionKind.CONFIRM, status: "applied", auditEventType: "confirmed",
          auditEventId: "resolution-event-1", activatedClaimId: "claim-1", effectDecision: "allow", electionStatus: "failed" };
      } },
      trustStateRecorder: { findDeliveryById: async () => delivery() },
      claimSourceReader: { findSourceObjectRefs: async () => ["memory-1"] },
      causalUsageRecorder: { record: async () => { throw new Error("usage unavailable"); } }
    });
    await expect(handler.resolve(request(), { ...context, abortSignal: abort.signal })).resolves.toMatchObject({
      status: "applied", audit_event_id: "resolution-event-1", usage_recording_status: "failed", election_status: "failed"
    });
  });

  it("does not record usage when the authoritative resolution fails", async () => {
    const record = vi.fn(async () => undefined);
    const handler = createSoulResolveHandler({
      resolutionService: { resolve: async () => { throw new Error("resolution failed"); } },
      trustStateRecorder: { findDeliveryById: async () => delivery() },
      claimSourceReader: { findSourceObjectRefs: async () => ["memory-1"] },
      causalUsageRecorder: { record }
    });

    await expect(handler.resolve(request(), context)).rejects.toThrow("resolution failed");
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    [SoulResolutionKind.REJECT, "applied", undefined],
    [SoulResolutionKind.CORRECT, "applied", "allow"],
    [SoulResolutionKind.STALE, "applied", undefined],
    [SoulResolutionKind.DEFER, "deferred", undefined],
    [SoulResolutionKind.NOT_RELEVANT, "noop", undefined],
    [SoulResolutionKind.CONFIRM, "noop", "deny"]
  ] as const)("does not reinforce %s/%s outcomes", async (resolution, status, effectDecision) => {
    const record = vi.fn(async () => undefined);
    const handler = createSoulResolveHandler({
      resolutionService: {
        resolve: async () => ({
          resolution,
          status,
          auditEventType: "soul.resolution.test",
          auditEventId: "resolution-event-1",
          ...(effectDecision === undefined ? {} : { effectDecision })
        })
      },
      trustStateRecorder: { findDeliveryById: async () => delivery() },
      claimSourceReader: { findSourceObjectRefs: async () => ["memory-1"] },
      causalUsageRecorder: { record }
    });

    await handler.resolve({ ...request(), resolution }, context);

    expect(record).not.toHaveBeenCalled();
  });
});

function request() {
  return {
    delivery_id: "delivery-1",
    target_object_id: "claim-1",
    resolution: SoulResolutionKind.CONFIRM
  };
}

function delivery() {
  return {
    delivery_id: "delivery-1",
    agent_target: "agent-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: ["memory-1"],
    delivered_objects: [{ object_id: "memory-1", object_kind: "memory_entry" }]
  };
}
