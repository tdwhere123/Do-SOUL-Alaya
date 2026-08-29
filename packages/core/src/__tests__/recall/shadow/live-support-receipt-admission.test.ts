import { describe, expect, it } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { fieldCandidates } from "./canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  cleanup,
  diagnostics,
  keyOf,
  params,
  preparedAuthority,
  supportReceipts
} from "./live-receipt-fixtures.js";

describe("live support receipt admission", () => {
  it("rejects support missing hypothesis and evidence", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: [{
        candidate_key: keyOf("cand-a"),
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: []
        }
      }]
    });

    expect(diagnostics(captured(result.shadowTrace)).producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "malformed",
      contract_code: "producer_contract_invalid"
    });
    expect(result.candidates).toEqual(fineAssess(params(candidates)).candidates);
    cleanup(prepared);
  });

  it.each([
    ["query", { query_id: "condition-from-another-query" }],
    ["snapshot", { snapshot_digest: `sha256:${"f".repeat(64)}` }]
  ] as const)("rejects unbound same-candidate metadata with stale %s labels", async (
    _kind,
    staleIdentity
  ) => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const receipt = { ...supportReceipts()[0]!, ...staleIdentity };
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: [receipt]
    });

    expect(diagnostics(captured(result.shadowTrace)).producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "malformed",
      contract_code: "producer_contract_invalid"
    });
    expect(result.candidates).toEqual(base.candidates);
    expect(result.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });
});
