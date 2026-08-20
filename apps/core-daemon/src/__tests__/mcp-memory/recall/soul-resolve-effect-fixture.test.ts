import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  ScopeClass,
  type ClaimForm,
  type ContextDeliveryRecord
} from "@do-soul/alaya-protocol";
import { createSoulResolveEffectFixture } from "./soul-resolve-effect-fixture.js";

const FIXED_NOW = "2026-05-17T00:00:00.000Z";

describe("soul.resolve in-memory effect lookup", () => {
  it("denies activate when the target is erased", async () => {
    const claims = new Map<string, ClaimForm>([["claim-1", buildClaim()]]);
    const fixture = createSoulResolveEffectFixture({
      claims,
      deliveries: new Map([["delivery-1", delivery()]]),
      erased: new Set(["claim-1"])
    });

    await expect(fixture.effectAuthority.decide(activateInput())).resolves.toMatchObject({
      decision: "deny"
    });
  });

  it("defers activate when two live evidenced claims share a canonical key", async () => {
    const claims = new Map<string, ClaimForm>([
      ["claim-1", buildClaim({
        object_id: "claim-1",
        evidence_refs: ["ev-1"],
        created_at: "2026-05-16T00:00:00.000Z"
      })],
      ["claim-2", buildClaim({
        object_id: "claim-2",
        evidence_refs: ["ev-2"],
        created_at: "2026-05-16T12:00:00.000Z"
      })]
    ]);
    const fixture = createSoulResolveEffectFixture({
      claims,
      deliveries: new Map([["delivery-1", delivery()]])
    });

    await expect(fixture.effectAuthority.decide(activateInput())).resolves.toMatchObject({
      decision: "defer"
    });
  });
});

function activateInput() {
  return {
    workspaceId: "ws-e2e",
    actorId: "codex",
    runId: "run-e2e",
    deliveryId: "delivery-1",
    targetObjectId: "claim-1",
    scope: "ws-e2e",
    effectiveAsOf: FIXED_NOW,
    action: "activate" as const
  };
}

function buildClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: overrides.object_id ?? "claim-1",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "test",
    governance_subject: {
      domain: "test",
      qualifiers: {},
      canonical_key: "test:test"
    },
    claim_kind: "preference",
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "advisory",
    origin_tier: "consolidated",
    precedence_basis: "evidence_strength",
    proposition_digest: "digest",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: "ws-e2e",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  } as ClaimForm;
}

function delivery(): ContextDeliveryRecord {
  return {
    delivery_id: "delivery-1",
    agent_target: "codex",
    workspace_id: "ws-e2e",
    run_id: "run-e2e",
    delivered_object_ids: ["claim-1"],
    delivered_objects: [{ object_id: "claim-1", object_kind: "claim_form" }],
    delivered_at: FIXED_NOW,
    audit_event_id: "delivery-evt-1"
  };
}
