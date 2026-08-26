import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCanonicalD0SelectionReceipt,
  CANONICAL_D0_IDENTITY_BLOB,
  CANONICAL_D0_IDENTITY_DIGEST,
  verifyCanonicalD0SelectionReceipt
} from "../../soul/selection/d0/canonical-d0-selection-receipt.js";
import { canonicalJson } from "../../soul/selection/d0/canonical-json.js";

describe("canonical D0 instance receipt", () => {
  it("owns an identity blob whose bytes match the published digest", () => {
    expect(sha256(CANONICAL_D0_IDENTITY_BLOB)).toBe(CANONICAL_D0_IDENTITY_DIGEST);
  });
  it("binds the exact body and rejects a recomposed digest", () => {
    const receipt = createCanonicalD0SelectionReceipt(failedBody(), sha256);
    expect(verifyCanonicalD0SelectionReceipt(receipt, sha256)).toEqual(receipt);
    expect(() => verifyCanonicalD0SelectionReceipt({
      ...receipt,
      execution: { status: "fail_closed", reason: "prefix_violation" }
    }, sha256)).toThrow(/digest mismatch/u);
  });

  it("requires fail-closed Gamma to be empty and E1 to be unavailable", () => {
    expect(() => createCanonicalD0SelectionReceipt({
      ...failedBody(),
      dispositions: []
    }, sha256)).toThrow(/not closed/u);
  });

  it("canonicalizes nested object keys for shared digest preimages", () => {
    expect(canonicalJson({ graph: { predicate: "p", arguments: ["a"] }, source: "s" }))
      .toBe(canonicalJson({ source: "s", graph: { arguments: ["a"], predicate: "p" } }));
  });

  it.each([
    { name: "nonempty Gamma", patch: { gamma: { set_utilities: [], decisions: [{}], rejects: [] } } },
    { name: "missing disposition", patch: { dispositions: [] } },
    { name: "nonempty delivery", patch: { delivery: [{ candidate_key: "a", delivery_rank: 1 }] } },
    { name: "wrong disposition reason", patch: { dispositions: [{ candidate_key: "a",
      status: "unavailable", reason: "ineligible" }] } }
  ])("rejects fail-closed $name", ({ patch }) => {
    expect(() => createCanonicalD0SelectionReceipt({ ...failedBody(), ...patch }, sha256))
      .toThrow();
  });

  it.each([
    { name: "omitted decision", patch: { gamma: { set_utilities: [utility()], decisions: [], rejects: [] } } },
    { name: "foreign reject", patch: { gamma: { set_utilities: [utility()], decisions: [decision()],
      rejects: [{ candidate_key: "foreign", reason: "dominated" }] } } },
    { name: "eligible unavailable", patch: { dispositions: [{ candidate_key: "a",
      status: "unavailable", reason: "fail_closed_unavailable" }] } },
    { name: "delivery gap", patch: { delivery: [{ candidate_key: "a", delivery_rank: 2 }] } },
    { name: "duplicate disposition", patch: { dispositions: [
      { candidate_key: "a", status: "selected", reason: "selected_by_gamma" },
      { candidate_key: "a", status: "selected", reason: "selected_by_gamma" }
    ] } },
    { name: "duplicate decision", patch: { gamma: {
      set_utilities: [utility()], decisions: [decision(), decision()], rejects: []
    } } },
    { name: "duplicate reject", patch: { gamma: { set_utilities: [utility()], decisions: [],
      rejects: [
        { candidate_key: "a", walk_reject: "max_total_tokens" },
        { candidate_key: "a", walk_reject: "max_total_tokens" }
      ] }, dispositions: [{ candidate_key: "a", status: "rejected",
      reason: "max_total_tokens" }], delivery: [] } }
  ])("rejects captured $name", ({ patch }) => {
    expect(() => createCanonicalD0SelectionReceipt({ ...capturedBody(), ...patch }, sha256))
      .toThrow();
  });
});

function failedBody() {
  return {
    schema_version: 1 as const,
    ranking_authority: "d0_prefix" as const,
    identity: {
      algorithm_id: "alaya.recall.shadow.d0.safe-dominance-capture.v1" as const,
      version: "d0.safe-dominance-capture.v1.0.0" as const,
      digest: "8f287df50610b28a3b40921b9bce765164794d6d4afd17c246e6807e768773fa" as const
    },
    execution: { status: "fail_closed" as const, reason: "invalid_state" as const },
    field_membership: { e0_keys: ["a"], e1_keys: ["a"], eligible_keys: [] },
    observations_by_candidate_key: null,
    frontiers: null,
    gamma: { set_utilities: [], decisions: [], rejects: [] },
    dispositions: [{ candidate_key: "a", status: "unavailable" as const,
      reason: "fail_closed_unavailable" as const }],
    delivery: []
  };
}

function capturedBody() {
  return {
    ...failedBody(),
    execution: { status: "captured" as const, reason: null },
    field_membership: { e0_keys: ["a"], e1_keys: ["a"], eligible_keys: ["a"] },
    observations_by_candidate_key: { a: { h_gate: "none" as const, lineages: {} } },
    frontiers: { schema_version: 1 as const,
      operator_id: "shadow.frontiers.peel_undominated.v1" as const,
      layers: [{ index: 1, member_keys: ["a"] }] },
    gamma: { set_utilities: [utility()], decisions: [decision()], rejects: [] },
    dispositions: [{ candidate_key: "a", status: "selected" as const,
      reason: "selected_by_gamma" as const }],
    delivery: [{ candidate_key: "a", delivery_rank: 1 }]
  };
}

function utility() {
  return { schema_version: 1 as const, candidate_key: "a", object_key: "object:a",
    obligations: [], matches: [], values: { status: "unavailable" as const, values: [] },
    cid: { status: "unavailable" as const }, availability: { facility: "not_applicable" as const,
      values: "unavailable" as const, evidence_identity: "unavailable" as const } };
}

function decision() {
  return { schema_version: 1 as const, candidate_key: "a", capture_reason: "core_undominated" as const,
    G: { unscaled_remainder: 0, Values_v: 0, evidence_novelty_redundancy: 0 },
    G_status: { facility: "not_applicable" as const, values: "unavailable" as const,
      evidence_identity: "unavailable" as const }, named_novelty: {
      facility_keys: [], value_pairs: [], content_ids: [] }, novelty_core_known_absence: [],
    max_g_cohort: ["a"], equal_g_dominance_rejects: [],
    deterministic_tail: "candidate_key_code_unit_ascending" as const,
    unresolved_pointwise_tradeoff: false, h_gate: "none" as const,
    walk_reject: "none" as const, static_frontier_index: 1 };
}

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
