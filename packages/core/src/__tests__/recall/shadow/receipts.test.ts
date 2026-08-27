import { describe, expect, it } from "vitest";
import type { SelectGammaRequest } from
  "../../../recall/delivery/select-gamma/types.js";
import {
  assertShadowReceiptHasNoDeliveryOrder,
  observationFromUnsupportedDiagnostic,
  parseCaptureDecisionReceipt,
  parseCoreKnownNoWitness,
  parseEqualGReject,
  parseFieldMembership,
  parseFrontierReceipt,
  parsePsiEdge,
  parsePsiPairReceipt,
  parseSetUtilityInput,
  parseUnsupportedRelationalDiagnostic,
  rejectNegativeRelationalEvidence,
  SHADOW_FRONTIER_OPERATOR_ID,
  SHADOW_PSI_OPERATOR_ID,
  type ShadowHasDeliveryOrderField,
  type ShadowSetUtilityInput,
  type ShadowUnsupportedRelationalSource
} from "../../../recall/shadow/index.js";

function acceptSelectGamma(_request: SelectGammaRequest): void {}

function utility(): ShadowSetUtilityInput {
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: "cand-a",
    object_key: "obj-a",
    obligations: [],
    matches: [],
    values: { status: "unavailable", values: [] },
    cid: { status: "unavailable" },
    availability: {
      facility: "not_applicable",
      values: "unavailable",
      evidence_identity: "unavailable"
    }
  });
}

describe("shadow receipts", () => {
  it("records E0/E1 membership and embedding-admission provenance", () => {
    const e0 = parseFieldMembership({
      candidate_key: "cand-a",
      e0_member: true,
      e1_member: true,
      admits: ["fts.admit.v1"],
      embedding_admission: null
    });
    expect(e0.e0_member).toBe(true);
    expect(e0.embedding_admission).toBeNull();
    const e1 = parseFieldMembership({
      candidate_key: "cand-b",
      e0_member: false,
      e1_member: true,
      admits: ["embed.admit.v1"],
      embedding_admission: {
        receipt: "embed.admit.v1",
        membership_only: true,
        cannot_evict_e0: true
      }
    });
    expect(e1.embedding_admission?.receipt).toBe("embed.admit.v1");
    expect(() => parseFieldMembership({
      candidate_key: "cand-c",
      e0_member: true,
      e1_member: false,
      admits: ["fts.admit.v1"],
      embedding_admission: null
    })).toThrow(/H_E0/u);
  });

  it("keeps Path/Flood facts as unsupported diagnostics that cannot construct O", () => {
    const diagnostic = parseUnsupportedRelationalDiagnostic({
      kind: "unsupported_relational_diagnostic",
      source: "flood",
      facts: { flood_value: 0, path_status: "none" }
    });
    expect(diagnostic.kind).toBe("unsupported_relational_diagnostic");
    expect(() => observationFromUnsupportedDiagnostic(diagnostic))
      .toThrow(/cannot instantiate v1 observation/u);
  });

  it.each([
    "not_observed",
    "producer_unavailable",
    "truncation",
    "cap_exhaustion",
    "no_path_under_cap"
  ] satisfies ShadowUnsupportedRelationalSource[])(
    "rejects %s as negative relational evidence",
    (source) => {
      const diagnostic = parseUnsupportedRelationalDiagnostic({
        kind: "unsupported_relational_diagnostic",
        source,
        facts: { truncated: true, cap: 50 }
      });
      expect(() => rejectNegativeRelationalEvidence(diagnostic))
        .toThrow(/negative relational evidence/u);
    }
  );

  it("names Psi edges, max-G cohort, equal-G rejects, and the deterministic tail", () => {
    expect(parsePsiEdge({
      kind: "psi_edge",
      operator_id: SHADOW_PSI_OPERATOR_ID,
      dominator: "a",
      dominated: "b"
    })).toMatchObject({ dominator: "a", dominated: "b" });
    expect(parsePsiPairReceipt({
      left: "a",
      right: "b",
      reason: "blocked",
      dominates: false
    }).reason).toBe("blocked");
    expect(parseEqualGReject({
      candidate_key: "b",
      dominated_by: "a"
    }).dominated_by).toBe("a");
    const decision = parseCaptureDecisionReceipt({
      schema_version: 1,
      candidate_key: "a",
      capture_reason: "core_undominated",
      G: { unscaled_remainder: 0, Values_v: 0, evidence_novelty_redundancy: 0 },
      G_status: {
        facility: "not_applicable",
        values: "unavailable",
        evidence_identity: "unavailable"
      },
      named_novelty: { facility_keys: [], value_pairs: [], content_ids: [] },
      novelty_core_known_absence: [],
      max_g_cohort: ["a", "b"],
      equal_g_dominance_rejects: [{ candidate_key: "b", dominated_by: "a" }],
      deterministic_tail: "origin_plane_object_id_code_unit_ascending",
      unresolved_pointwise_tradeoff: false,
      h_gate: "none",
      walk_reject: "none",
      static_frontier_index: 1
    });
    expect(decision.max_g_cohort).toEqual(["a", "b"]);
    expect(decision.deterministic_tail).toBe("origin_plane_object_id_code_unit_ascending");
    expect("selection_order" in decision).toBe(false);
  });

  it("rejects Core unavailable as a known-no-witness exclusivity proof", () => {
    expect(() => parseCoreKnownNoWitness({
      witness: "facility",
      core_candidate_key: "core-a",
      status: "unavailable",
      basis: "cover=0"
    })).toThrow(/cannot prove exclusivity/u);
    expect(parseCoreKnownNoWitness({
      witness: "values",
      core_candidate_key: "core-a",
      status: "available_known_absent",
      basis: "composed without pair"
    }).status).toBe("available_known_absent");
  });

  it("serializes frontier members without treating index as gain", () => {
    const receipt = parseFrontierReceipt({
      schema_version: 1,
      operator_id: SHADOW_FRONTIER_OPERATOR_ID,
      layers: [{ index: 1, member_keys: ["a", "b"] }]
    });
    expect(receipt.layers[0]?.index).toBe(1);
    expect(() => parseFrontierReceipt({
      schema_version: 1,
      operator_id: SHADOW_FRONTIER_OPERATOR_ID,
      layers: [{ index: 1, member_keys: ["a"], score: 0.9 }]
    })).toThrow(/structure, not gain/u);
  });

  it("cannot feed shadow receipts into selectGammaWalk", () => {
    const receipt = utility();
    const noDelivery: [ShadowHasDeliveryOrderField<ShadowSetUtilityInput>] extends [never]
      ? true
      : false = true;
    expect(noDelivery).toBe(true);
    assertShadowReceiptHasNoDeliveryOrder(receipt);
    expect("ordering_basis" in receipt).toBe(false);
    expect("selected_candidate_keys" in receipt).toBe(false);
    // @ts-expect-error shadow set-utility is not a Select_Gamma request
    acceptSelectGamma(receipt);
  });
});
