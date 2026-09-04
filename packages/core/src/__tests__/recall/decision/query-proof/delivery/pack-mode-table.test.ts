import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import { CAPTURE_IDENTITY_DIGEST } from
  "../../../../../recall/decision/prefix-capture/identity.js";
import {
  NON_INTERFERING_PRINCIPAL_SCOPE,
  SEAL_UNBOUND_HOLE,
  type DeliveryPackInputV1,
  type DeliveryPackModeV1
} from "../../../../../recall/decision/query-proof/delivery/contract.js";
import {
  buildDeliveryPack,
  buildShadowDeliveryPack,
  parseCertifiedDeliveryPack
} from "../../../../../recall/decision/query-proof/delivery/pack.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";

describe("query-proof pack mode table", () => {
  it.each([
    ["certified", ["completeness_prohibition", "scalar", "uncertainty_exposure"]],
    ["best_effort_uncertified", ["completeness_prohibition", "uncertainty_exposure"]],
    ["abstained", ["completeness_prohibition", "uncertainty_exposure"]],
    ["unsupported", ["completeness_prohibition", "uncertainty_exposure"]],
    ["conflict", ["completeness_prohibition", "uncertainty_exposure"]]
  ] as const)("%s claims", (mode, claims) => {
    const pack = buildDeliveryPack(inputFor(mode));
    expect(pack.mode).toBe(mode);
    expect(pack.allowed_claims).toEqual([...claims]);
    if (mode === "certified") {
      expect(parseCertifiedDeliveryPack(pack).mode).toBe("certified");
    } else {
      expect(() => parseCertifiedDeliveryPack(pack)).toThrow(/certified/u);
    }
  });

  it("does not default a missing shadow mode to certified", () => {
    const pack = buildShadowDeliveryPack({
      selected_candidates: ["target"],
      capture_identity_digest: CAPTURE_IDENTITY_DIGEST
    });
    expect(pack.mode).toBe("abstained");
    expect(pack.selected_candidates).toEqual(["target"]);
    expect(pack.holes).toEqual([SEAL_UNBOUND_HOLE]);
    expect(() => parseCertifiedDeliveryPack(pack)).toThrow(/certified/u);
  });

  it("requires explicit certified mode and bound digests", () => {
    expect(() => buildShadowDeliveryPack({
      selected_candidates: ["target"],
      capture_identity_digest: CAPTURE_IDENTITY_DIGEST,
      mode: "certified"
    })).toThrow(ShadowContractError);
  });

  it("does not emit empty conflicts in conflict mode", () => {
    const pack = buildDeliveryPack(inputFor("conflict"));
    expect(pack.conflicts.length).toBeGreaterThan(0);
    expect(pack.holes).toEqual([SEAL_UNBOUND_HOLE]);
  });

  it("verifies supplied decision identity against capture identity", () => {
    const identity = digestRecallFieldIdentity("decision-identity");
    expect(() => buildShadowDeliveryPack({
      selected_candidates: ["target"],
      capture_identity_digest: CAPTURE_IDENTITY_DIGEST,
      decision_identity_digest: identity
    })).toThrow(/decision identity/u);
    const pack = buildShadowDeliveryPack({
      selected_candidates: ["target"],
      capture_identity_digest: identity,
      decision_identity_digest: identity
    });
    expect(pack.capture_identity_digest).toBe(identity);
    expect(pack.mode).toBe("abstained");
  });
});

function inputFor(mode: DeliveryPackModeV1): DeliveryPackInputV1 {
  const certified = mode === "certified";
  return {
    mode,
    query_digest: digestRecallFieldIdentity("delivery-pack-query"),
    snapshot_digest: digestRecallFieldIdentity("delivery-pack-snapshot"),
    decision_contract_digest: digestRecallFieldIdentity("delivery-pack-contract"),
    capture_identity_digest: CAPTURE_IDENTITY_DIGEST,
    selected_candidates: ["workspace_local:memory_entry:a"],
    answer_kind: certified ? "scalar" : "none",
    answer_bindings: certified ? [{ binding_id: "x0", value: "answer" }] : [],
    propositions: [],
    evidence_groups: [],
    holes: certified ? [] : [SEAL_UNBOUND_HOLE],
    conflicts: mode === "conflict"
      ? [{ conflict_id: "c1", kind: "unresolved_tradeoff", coordinate_ids: [] }]
      : [],
    completeness_scope: null,
    principal_scope: NON_INTERFERING_PRINCIPAL_SCOPE
  };
}
