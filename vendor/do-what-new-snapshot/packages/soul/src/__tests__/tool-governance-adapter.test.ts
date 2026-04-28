import {
  ClaimLifecycleState,
  ToolGovernanceDecisionSchema,
  canonicalGovernanceSubject,
  type ClaimForm,
  type Slot,
  type ToolGovernanceQuery
} from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { SoulToolGovernanceAdapter } from "../index.js";

function createQuery(overrides: Partial<ToolGovernanceQuery> = {}): ToolGovernanceQuery {
  return {
    governance_subject: canonicalGovernanceSubject("tooling.policy", { project: "alpha" }),
    tool_category: "read",
    scope_guard: "project",
    destructive: false,
    requested_by: "principal",
    request_context: {
      node_template: "build",
      project_ref: "project-alpha"
    },
    ...overrides
  };
}

function createClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "claim-1",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
    created_by: "user_action",
    governance_subject: canonicalGovernanceSubject("tooling.policy", { project: "alpha" }),
    claim_kind: "preference",
    scope_class: "project",
    enforcement_level: "preferred",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Prefer workspace-safe tooling.",
    evidence_refs: [],
    source_object_refs: [],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}

function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: "slot-1",
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-12T00:00:00.000Z",
    updated_at: "2026-04-12T00:00:00.000Z",
    created_by: "system",
    governance_subject: canonicalGovernanceSubject("tooling.policy", { project: "alpha" }),
    claim_kind: "preference",
    scope_class: "project",
    winner_claim_id: "claim-1",
    incumbent_since: "2026-04-12T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SoulToolGovernanceAdapter", () => {
  it("allows when matched structure has no strict, contested, or unresolved governance blockers", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => [
        createClaim(),
        createClaim({
          object_id: "claim-other-subject",
          governance_subject: canonicalGovernanceSubject("other.domain", { project: "alpha" })
        })
      ]),
      listSlotsForProject: vi.fn(async () => [createSlot()]),
      mutate: vi.fn()
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    const decision = await adapter.queryToolGovernance(createQuery());

    expect(adapter.kind).toBe("soul-governance-adapter");
    expect(adapter.kind.length).toBeGreaterThan(0);
    expect(ToolGovernanceDecisionSchema.parse(decision)).toEqual(decision);
    expect(decision.final_result).toBe("allow");
    expect(decision.matched_claim_refs).toEqual(["claim-1"]);
    expect(decision.matched_slot_refs).toEqual(["slot-1"]);
    expect(decision.explanation_summary).toContain("Matched 1 claims and 1 slots");
    expect(reader.listClaimsForProject).toHaveBeenCalledWith("project-alpha");
    expect(reader.listSlotsForProject).toHaveBeenCalledWith("project-alpha");
    expect(reader.mutate).not.toHaveBeenCalled();
  });

  it("asks when matched structure is unresolved or contested", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => [
        createClaim({
          object_id: "claim-contested",
          claim_kind: "procedure",
          claim_status: ClaimLifecycleState.CONTESTED
        })
      ]),
      listSlotsForProject: vi.fn(async () => [
        createSlot({
          object_id: "slot-unresolved",
          winner_claim_id: null,
          incumbent_since: null
        })
      ])
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    const decision = await adapter.queryToolGovernance(createQuery());

    expect(decision.final_result).toBe("ask");
    expect(decision.hard_constraints_present).toBe(false);
    expect(decision.requires_red_card).toBe(false);
    expect(decision.matched_claim_refs).toEqual(["claim-contested"]);
    expect(decision.matched_slot_refs).toEqual(["slot-unresolved"]);
    expect(decision.explanation_summary).toContain("contested");
  });

  it("ignores matched structure from a different scope class", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => [
        createClaim({
          object_id: "claim-global",
          scope_class: "global_domain",
          enforcement_level: "strict"
        })
      ]),
      listSlotsForProject: vi.fn(async () => [
        createSlot({
          object_id: "slot-global",
          scope_class: "global_domain",
          winner_claim_id: "claim-global"
        })
      ])
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    const decision = await adapter.queryToolGovernance(createQuery());

    expect(decision.final_result).toBe("allow");
    expect(decision.matched_claim_refs).toEqual([]);
    expect(decision.matched_slot_refs).toEqual([]);
    expect(decision.hard_constraints_present).toBe(false);
  });

  it("does not treat a strict non-winning claim as a hard constraint when a different winner is present", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => [
        createClaim({
          object_id: "claim-strict-non-winner",
          claim_kind: "constraint",
          enforcement_level: "strict"
        }),
        createClaim({
          object_id: "claim-winning-preference"
        })
      ]),
      listSlotsForProject: vi.fn(async () => [
        createSlot({
          winner_claim_id: "claim-winning-preference"
        })
      ])
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    const decision = await adapter.queryToolGovernance(
      createQuery({
        destructive: true
      })
    );

    expect(decision.final_result).toBe("allow");
    expect(decision.hard_constraints_present).toBe(false);
    expect(decision.requires_red_card).toBe(false);
  });

  it("denies when matched strict governance requires a red card", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => [
        createClaim({
          object_id: "claim-strict",
          claim_kind: "constraint",
          enforcement_level: "strict",
          claim_status: ClaimLifecycleState.WINNER
        })
      ]),
      listSlotsForProject: vi.fn(async () => [createSlot({ object_id: "slot-strict", winner_claim_id: "claim-strict" })])
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    const decision = await adapter.queryToolGovernance(
      createQuery({
        destructive: true
      })
    );

    expect(decision.final_result).toBe("deny");
    expect(decision.hard_constraints_present).toBe(true);
    expect(decision.requires_red_card).toBe(true);
    expect(decision.matched_claim_refs).toEqual(["claim-strict"]);
    expect(decision.matched_slot_refs).toEqual(["slot-strict"]);
    expect(decision.explanation_summary).toContain("strict");
  });

  it("rethrows reader failures without masking them", async () => {
    const reader = {
      listClaimsForProject: vi.fn(async () => {
        throw new Error("claim reader unavailable");
      }),
      listSlotsForProject: vi.fn(async () => [])
    };
    const adapter = new SoulToolGovernanceAdapter(reader);

    await expect(adapter.queryToolGovernance(createQuery())).rejects.toThrow("claim reader unavailable");
  });
});
