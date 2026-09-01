import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import { CAPTURE_IDENTITY_DIGEST } from
  "../../../../../recall/decision/prefix-capture/identity.js";
import {
  NON_INTERFERING_PRINCIPAL_SCOPE,
  SEAL_UNBOUND_HOLE,
  unavailableDeliveryDigest,
  type DeliveryPackInputV1
} from "../../../../../recall/decision/query-proof/delivery/contract.js";
import {
  buildDeliveryPack,
  parseCertifiedDeliveryPack,
  parseDeliveryPack
} from "../../../../../recall/decision/query-proof/delivery/pack.js";
import { validateConsumerAction } from
  "../../../../../recall/decision/query-proof/delivery/validate.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";

const ALL_OBSERVABLE_SCOPE = Object.freeze({
  kind: "all_observable" as const,
  scope: "finite-authorized",
  principal: "principal-1",
  observer_contract: "observer-v1",
  snapshot_bind: "Sigma_q" as const
});

describe("delivery pack modes", () => {
  it.each([
    ["certified", certifiedInput()],
    ["best_effort_uncertified", uncertifiedInput("best_effort_uncertified")],
    ["abstained", uncertifiedInput("abstained")],
    ["unsupported", uncertifiedInput("unsupported")],
    ["conflict", conflictInput()]
  ] as const)("builds and round-trips %s", (_mode, input) => {
    const pack = buildDeliveryPack(input);
    expect(pack.mode).toBe(input.mode);
    expect(pack.prefix_authority).toBe("prefix_sk");
    expect(pack.utilization).toBe("delivered_not_used");
    expect(pack.principal_scope.delivery_interference).toBe(false);
    expect(parseDeliveryPack(pack)).toEqual(pack);
    expect(parseDeliveryPack(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
  });

  it("keeps allowed claims independent of packet length", () => {
    const one = buildDeliveryPack(certifiedInput({
      selected_candidates: ["only"],
      answer_kind: "none"
    }));
    expect(one.allowed_claims).not.toContain("scalar");
    expect(validateConsumerAction(one, "claim_scalar").status).toBe("rejected");
  });
});

describe("delivery pack capture", () => {
  it("reads only the captured premises", () => {
    const selected = ["a"];
    const pack = buildDeliveryPack(certifiedInput({ selected_candidates: selected }));
    selected.push("hack");
    expect(pack.selected_candidates).toEqual(["a"]);
  });

  it("rejects getter premises", () => {
    const input = { ...certifiedInput() };
    Object.defineProperty(input, "mode", {
      enumerable: true,
      get: () => "certified"
    });
    expect(() => buildDeliveryPack(input)).toThrow(ShadowContractError);
    expect(() => buildDeliveryPack(input)).toThrow(/getters/u);
  });

  it("rejects proxies and array getters without a second live read", () => {
    const proxy = new Proxy(certifiedInput(), {
      get(target, property, receiver) {
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => buildDeliveryPack(proxy)).toThrow(/proxies/u);
    const selected: string[] = ["a"];
    Object.defineProperty(selected, 0, {
      configurable: true,
      enumerable: true,
      get: () => "hack"
    });
    expect(() => buildDeliveryPack(certifiedInput({ selected_candidates: selected })))
      .toThrow(/getters/u);
  });
});

describe("certified parse and claims", () => {
  it("parses a certified scalar pack and accepts the scalar claim", () => {
    const pack = buildDeliveryPack(certifiedInput());
    expect(pack.allowed_claims).toEqual([
      "completeness_prohibition", "scalar", "uncertainty_exposure"
    ]);
    expect(parseCertifiedDeliveryPack(pack).mode).toBe("certified");
    expect(validateConsumerAction(pack, "parse_as_certified")).toEqual({
      status: "accepted"
    });
    expect(validateConsumerAction(pack, "claim_scalar")).toEqual({
      status: "accepted"
    });
  });

  it("rejects best-effort as certified", () => {
    const pack = buildDeliveryPack(uncertifiedInput("best_effort_uncertified"));
    expect(() => parseCertifiedDeliveryPack(pack)).toThrow(/certified/u);
    expect(validateConsumerAction(pack, "parse_as_certified").status).toBe("rejected");
    expect(validateConsumerAction(pack, "claim_scalar").status).toBe("rejected");
  });

  it("rejects flipping best-effort JSON to certified", () => {
    const pack = buildDeliveryPack(uncertifiedInput("best_effort_uncertified"));
    const flipped = { ...JSON.parse(JSON.stringify(pack)), mode: "certified" };
    expect(() => parseCertifiedDeliveryPack(flipped)).toThrow(ShadowContractError);
  });

  it("rejects a stripped best-effort rewrite that omits digest and holes", () => {
    const pack = buildDeliveryPack(uncertifiedInput("best_effort_uncertified"));
    const { pack_digest: _digest, allowed_claims: _claims, ...rest } =
      JSON.parse(JSON.stringify(pack)) as Record<string, unknown>;
    expect(() => parseCertifiedDeliveryPack({
      ...rest,
      mode: "certified",
      holes: []
    })).toThrow(ShadowContractError);
  });

  it("rejects certified packs that carry unavailable digests", () => {
    expect(() => buildDeliveryPack(certifiedInput({
      query_digest: unavailableDeliveryDigest("query_digest")
    }))).toThrow(/unavailable/u);
  });

  it("rejects packet size as completeness or scalar/extremum proof", () => {
    const pack = buildDeliveryPack(certifiedInput({
      selected_candidates: ["a", "b", "c"]
    }));
    expect(validateConsumerAction(pack, "infer_completeness_from_packet_size")).toEqual({
      status: "rejected",
      reason: "packet size cannot satisfy completeness, scalar, or extremum claims"
    });
  });

  it("rejects hidden filter, reorder, membership cut, and used", () => {
    const pack = buildDeliveryPack(certifiedInput());
    for (const action of [
      "hidden_filter", "hidden_reorder", "hidden_membership_cut", "mark_used"
    ] as const) {
      expect(validateConsumerAction(pack, action).status).toBe("rejected");
    }
  });
});

describe("missing pack data rejects the matching action", () => {
  it("does not license all_observable from malformed completeness scope", () => {
    const pack = buildDeliveryPack(certifiedInput({
      answer_kind: "all_observable",
      completeness_scope: { kind: "all_observable" } as never
    }));
    expect(pack.completeness_scope).toBeNull();
    expect(pack.allowed_claims).not.toContain("scoped_all_observable");
    expect(validateConsumerAction(pack, "claim_scoped_all_observable").status).toBe("rejected");
  });

  it("rejects all_observable without completeness scope", () => {
    const pack = buildDeliveryPack(certifiedInput({
      answer_kind: "all_observable",
      completeness_scope: null
    }));
    expect(pack.allowed_claims).not.toContain("scoped_all_observable");
    expect(validateConsumerAction(pack, "claim_scoped_all_observable").reason)
      .toMatch(/allow|scope/u);
  });

  it("licenses scoped extremum only when certified with that answer kind", () => {
    const pack = buildDeliveryPack(certifiedInput({ answer_kind: "extremum" }));
    expect(pack.allowed_claims).toEqual([
      "completeness_prohibition", "scoped_extremum", "uncertainty_exposure"
    ]);
    expect(validateConsumerAction(pack, "claim_scoped_extremum")).toEqual({
      status: "accepted"
    });
    expect(validateConsumerAction(pack, "claim_scalar").status).toBe("rejected");
    expect(validateConsumerAction(pack, "infer_completeness_from_packet_size").status)
      .toBe("rejected");
  });

  it("licenses scoped all_observable only with scope and no completeness hole", () => {
    const pack = buildDeliveryPack(certifiedInput({
      answer_kind: "all_observable",
      completeness_scope: ALL_OBSERVABLE_SCOPE
    }));
    expect(pack.allowed_claims).toContain("scoped_all_observable");
    expect(validateConsumerAction(pack, "claim_scoped_all_observable")).toEqual({
      status: "accepted"
    });
    expect(validateConsumerAction(pack, "infer_completeness_from_packet_size").status)
      .toBe("rejected");
  });

  it("rejects all_observable when the completeness hole is present", () => {
    expect(() => buildDeliveryPack(certifiedInput({
      answer_kind: "all_observable",
      completeness_scope: ALL_OBSERVABLE_SCOPE,
      holes: [{
        provenance: "completion",
        code: "blocks_completeness_claim",
        impacts: ["blocks_completeness_claim", "blocks_certified_delivery"]
      }]
    }))).toThrow(/blocking holes/u);
  });

  it("rejects extremum without the allowed claim", () => {
    const pack = buildDeliveryPack(certifiedInput({ answer_kind: "scalar" }));
    expect(validateConsumerAction(pack, "claim_scoped_extremum").status).toBe("rejected");
  });

  it("rejects conflict mode without conflict records", () => {
    expect(() => buildDeliveryPack(uncertifiedInput("conflict"))).toThrow(/conflict records/u);
  });

  it("rejects parse when holes are omitted", () => {
    const pack = buildDeliveryPack(certifiedInput());
    const { holes: _holes, ...rest } = pack;
    expect(() => parseDeliveryPack(rest)).toThrow(/holes/u);
  });

  it("rejects parse when allowed claims are smuggled", () => {
    const pack = buildDeliveryPack(uncertifiedInput("abstained"));
    const smuggled = {
      ...JSON.parse(JSON.stringify(pack)),
      allowed_claims: ["scalar", "uncertainty_exposure"]
    };
    expect(() => parseDeliveryPack(smuggled)).toThrow(/allowed claims/u);
  });
});

function certifiedInput(
  override: Partial<DeliveryPackInputV1> = {}
): DeliveryPackInputV1 {
  return {
    mode: "certified",
    query_digest: digestRecallFieldIdentity("delivery-pack-query"),
    snapshot_digest: digestRecallFieldIdentity("delivery-pack-snapshot"),
    decision_contract_digest: digestRecallFieldIdentity("delivery-pack-contract"),
    capture_identity_digest: CAPTURE_IDENTITY_DIGEST,
    selected_candidates: ["workspace_local:memory_entry:a"],
    answer_kind: "scalar",
    answer_bindings: [{ binding_id: "x0", value: "answer" }],
    propositions: [{ proposition_id: "phi-1", support: "supports" }],
    evidence_groups: [{
      group_id: "g1",
      member_keys: ["workspace_local:memory_entry:a"],
      correlation: "unknown"
    }],
    holes: [],
    conflicts: [],
    completeness_scope: null,
    principal_scope: NON_INTERFERING_PRINCIPAL_SCOPE,
    ...override
  };
}

function uncertifiedInput(
  mode: Exclude<DeliveryPackInputV1["mode"], "certified" | "conflict">
): DeliveryPackInputV1 {
  return certifiedInput({
    mode,
    answer_kind: "none",
    holes: [SEAL_UNBOUND_HOLE]
  });
}

function conflictInput(): DeliveryPackInputV1 {
  return certifiedInput({
    mode: "conflict",
    answer_kind: "none",
    holes: [SEAL_UNBOUND_HOLE],
    conflicts: [{
      conflict_id: "c1",
      kind: "proposition_conflict",
      coordinate_ids: ["phi-1"]
    }]
  });
}
