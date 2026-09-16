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
});
