import { describe, expect, it } from "vitest";
import {
  observationFromUnsupportedDiagnostic,
  parseFieldMembership,
  parsePsiEdge,
  parsePsiPairReceipt,
  parseUnsupportedRelationalDiagnostic,
  rejectNegativeRelationalEvidence,
  SHADOW_PSI_OPERATOR_ID,
  type ShadowUnsupportedRelationalSource
} from "../../../../recall/decision/query-proof/receipts.js";

describe("query-proof receipts", () => {
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

  it("keeps Path/Flood facts outside pointwise observations", () => {
    const diagnostic = parseUnsupportedRelationalDiagnostic({
      kind: "unsupported_relational_diagnostic",
      source: "flood",
      facts: { flood_value: 0, path_status: "none" }
    });
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

  it("names Psi edges and non-dominating pair receipts", () => {
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
  });
});
