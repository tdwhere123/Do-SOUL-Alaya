import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
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

  it("confirm path: garden-compiled draft claim becomes active via soul.resolve.confirm", async () => {
    const harness = createHarness();
    // invariant: recall delivers a memory_entry that backs a draft
    // claim; the agent then resolves the claim through the indirect
    // source_object_refs scope path. This is the production-realistic
    // shape — RecallCandidate.object_kind is locked to "memory_entry".
    harness.memories.set("mem-source-1", buildMemory({ object_id: "mem-source-1" }));
    harness.claims.set(
      "claim-draft-1",
      buildClaim({ object_id: "claim-draft-1", source_object_refs: ["mem-source-1"] })
    );

    const recallResult = await harness.handler.call({
      toolName: "soul.recall",
      arguments: {
        protocol_version: 1,
        supported_result_kinds: ["memory_entry", "source_evidence"],
        supports_source_evidence: true,
        supports_product_updates: true,
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });
    expect(recallResult.ok).toBe(true);
    if (!recallResult.ok) return;
    const recallOutput = recallResult.output as {
      readonly delivery_id: string;
      readonly results: readonly { readonly object_id: string; readonly staged_warnings?: unknown }[];
    };
    expect(recallOutput.results[0]?.object_id).toBe("mem-source-1");
    expect(recallOutput.results[0]?.staged_warnings).toBeDefined();

    const resolveResult = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-draft-1",
        resolution: SoulResolutionKind.CONFIRM,
        delivery_id: recallOutput.delivery_id,
        policy: "conflict_detection.v1",
        reason: "agent confirmed after reviewing memory-42"
      },
      context
    });
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const resolveOutput = resolveResult.output as {
      readonly resolution: string;
      readonly status: string;
      readonly audit_event_type: string;
      readonly audit_event_id: string;
      readonly activated_claim_id?: string;
    };
    expect(resolveOutput.resolution).toBe("confirm");
    expect(resolveOutput.status).toBe("applied");
    expect(resolveOutput.audit_event_type).toBe(
      GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
    );
    expect(resolveOutput.activated_claim_id).toBe("claim-draft-1");

    expect(harness.claims.get("claim-draft-1")?.claim_status).toBe(ClaimLifecycleState.ACTIVE);
    expect(
      harness.events.find(
        (event) =>
          event.event_type ===
          GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
      )
    ).toBeDefined();
    expect(
      harness.events.find((event) => event.event_type === "soul.claim.lifecycle_changed")
    ).toBeDefined();
  });

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

  it("treats a foreign-workspace claim as missing rather than a claim_form target", async () => {
    const harness = createHarness();
    harness.claims.set(
      "claim-foreign",
      buildClaim({
        object_id: "claim-foreign",
        workspace_id: "other-workspace",
        source_object_refs: ["mem-source-1"]
      })
    );
    harness.deliveries.set("delivery-local", {
      delivery_id: "delivery-local",
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: ["mem-source-1"],
      delivered_objects: [{ object_id: "mem-source-1", object_kind: "memory_entry" }],
      delivered_at: FIXED_NOW,
      audit_event_id: "delivery-evt-local"
    });

    const result = await harness.handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "claim-foreign",
        resolution: SoulResolutionKind.CONFIRM,
        delivery_id: "delivery-local"
      },
      context
    });

    expect(result.ok).toBe(false);
    expect(
      harness.events.some(
        (event) => event.event_type === GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED
      )
    ).toBe(false);
  });

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
