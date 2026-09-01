import { describe, expect, it } from "vitest";
import {
  parseSetUtilityInput
} from "../../../../recall/decision/prefix-capture/capture.js";
import {
  isCapturedWalk,
  prefixSK,
  walkShadowCapture,
  type ShadowCaptureWalkCandidate
} from "../../../../recall/decision/prefix-capture/walk.js";
import {
  assertUnmixedWalkTransfer,
  LIVE_FACILITY_WALK_TRANSFER,
  type ShadowWalkUtilityTransfer
} from "../../../../recall/decision/prefix-capture/walk-transfer.js";
import { createQueryCompiledWalkTransfer } from
  "../../../../recall/decision/query-proof/gamma/walk-binding.js";
import {
  emptyWalkUtility,
  type QueryProofDecideWorldV1
} from "../../../../recall/decision/query-proof/seal/decide.js";
import { parseCaptureDecisionReceipt } from
  "../../../../recall/decision/prefix-capture/receipts.js";
import { ShadowContractError } from
  "../../../../recall/decision/contract-primitives.js";
import { previewSidecar } from
  "../../../../recall/integration/shadow/query-proof-preview.js";
import {
  binding,
  candidate,
  compileGamma,
  compileInputFor,
  distinctQuery,
  findGammaAtom,
  proposition,
  scalarQuery,
  sequenceQuery
} from "../query-proof/gamma/gamma-fixture.js";

function psiFrom(edges: readonly (readonly [string, string])[]) {
  const set = new Set(edges.map(([dom, sub]) => `${dom}\0${sub}`));
  return (dom: string, sub: string) => set.has(`${dom}\0${sub}`);
}

function lowerFrontierCoverWorld() {
  return {
    compiled: compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("f1", {
        bindings: [],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("g2", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      }),
      candidate("f3", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      })
    ]),
    psi: psiFrom([["f1", "g2"], ["f1", "f3"]])
  };
}

function row(
  key: string,
  frontier: number | null = null
): ShadowCaptureWalkCandidate {
  return {
    candidate_key: key,
    object_key: key,
    token_cost: 1,
    dimension: "mem",
    h_eligible: true,
    utility: emptyWalkUtility(key, key),
    static_frontier_index: frontier
  };
}

function facilityRow(
  key: string,
  covers: Readonly<Record<string, number>>,
  frontier: number | null
): ShadowCaptureWalkCandidate {
  const obligations = Object.entries(covers).map(([value, strength]) => ({
    key: { kind: "entity" as const, value },
    raw_atom_ids: [`typed:${value}`],
    availability: "available" as const,
    cover: strength,
    evaluated: true
  }));
  return {
    candidate_key: key,
    object_key: key,
    token_cost: 1,
    dimension: "mem",
    h_eligible: true,
    utility: parseSetUtilityInput({
      schema_version: 1,
      candidate_key: key,
      object_key: key,
      obligations,
      matches: obligations.map((row) => ({
        obligation: row.key,
        raw_atom_id: row.raw_atom_ids[0]!,
        attribution_kind: "typed_query_atom" as const,
        match_strength: row.cover
      })),
      values: { status: "no_match", values: [] },
      cid: { status: "unavailable" },
      availability: {
        facility: "available",
        values: "no_match",
        evidence_identity: "unavailable"
      }
    }),
    static_frontier_index: frontier
  };
}

describe("query-compiled Gamma walk binding", () => {
  it("uses the same walkShadowCapture function for live and v2 preview", () => {
    const live = walkShadowCapture({
      candidates: [row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null
    });
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const preview = walkShadowCapture({
      candidates: [row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(live)).toBe(true);
    expect(isCapturedWalk(preview)).toBe(true);
    expect(live).not.toHaveProperty("kind", "query_compiled_walk");
  });

  it("keeps prefixSK monotone for compiled sequence programs", () => {
    const compiled = compileGamma(sequenceQuery(2), [
      candidate("A", { sequence_slots: [{ position: 0, binding: "alice" }] }),
      candidate("B", { sequence_slots: [{ position: 1, binding: "bob" }] })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("A"), row("B")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(prefixSK(walked.S_infty, 1)).toEqual([walked.S_infty[0]]);
    expect(prefixSK(walked.S_infty, 2)).toEqual(walked.S_infty.slice(0, 2));
  });

  it("keeps prefixSK monotone for compiled operator fixtures", () => {
    const compiled = compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("B", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("A"), row("B")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    for (let k = 1; k <= walked.S_infty.length; k += 1) {
      expect(prefixSK(walked.S_infty, k)).toEqual(walked.S_infty.slice(0, k));
    }
  });

  it("lets a lower-frontier required-proposition gain enter without live facility novelty", () => {
    const compiled = compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("core", {
        bindings: [],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("lower", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("core", 1), row("lower", 2)],
      psi: psiFrom([["core", "lower"]]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("lower");
    expect(walked.decisions[0]?.capture_reason).toBe("cross_frontier_novelty");
    expect(walked.decisions[0]?.named_novelty.compiled_atom_ids)
      .toContain(findGammaAtom(compiled, { kind: "required_proposition", target: "rel2" }).atom_id);
    expect(walked.decisions[0]?.named_novelty.facility_keys).toEqual([]);
    expect(walked.decisions[0]?.G).toMatchObject({
      required_proposition_support: 1
    });
    expect(walked.decisions[0]?.G).not.toHaveProperty("Values_v");
  });

  it("does not admit a lower frontier when a higher eligible frontier still covers the atom", () => {
    const { compiled, psi } = lowerFrontierCoverWorld();
    const walked = walkShadowCapture({
      candidates: [row("f1", 1), row("g2", 2), row("f3", 3)],
      psi,
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect("f3" < "g2").toBe(true);
    expect(walked.S_infty[0]).toBe("g2");
    expect(walked.S_infty[0]).not.toBe("f3");
    expect(walked.decisions[0]?.capture_reason).toBe("cross_frontier_novelty");
    expect(walked.decisions[0]?.candidate_key).not.toBe("f3");
  });

  it("does not admit a null-index extra while another remaining candidate still covers the atom", () => {
    const { compiled, psi } = lowerFrontierCoverWorld();
    const walked = walkShadowCapture({
      candidates: [row("f1"), row("g2"), row("f3")],
      psi,
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("f1");
    expect(walked.S_infty[0]).not.toBe("f3");
    expect(walked.decisions[0]?.capture_reason).toBe("core_undominated");
    expect(walked.decisions.filter((row) => row.capture_reason === "cross_frontier_novelty")
      .map((row) => row.candidate_key)).not.toContain("f3");
  });

  it("does not let live-only novelty admit a lower-frontier candidate under compiled transfer", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("core", { bindings: [binding("alice")] }),
      candidate("lower", { bindings: [binding("alice")] })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("core", 1), row("lower", 2)],
      psi: psiFrom([["core", "lower"]]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("core");
    expect(walked.decisions[0]?.capture_reason).toBe("core_undominated");
  });

  it("picks a same-lineage second required proposition before an independent corroborator", () => {
    const compiled = compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ], [{
      id: "need-ind",
      constraint: "independent_support",
      arguments: ["x"]
    }]), [
      candidate("first", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1"),
          proposition("rel2", "absent"),
          proposition("need-ind", "absent", "not_applicable", "constraint")
        ]
      }),
      candidate("lineage", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1", "absent"),
          proposition("rel2", "supports", "correlated"),
          proposition("need-ind", "absent", "not_applicable", "constraint")
        ]
      }),
      candidate("extra", {
        bindings: [],
        propositions: [
          proposition("rel1"),
          proposition("rel2", "absent"),
          proposition("need-ind", "supports", "certified_independent", "constraint")
        ]
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("first"), row("lineage"), row("extra")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("first");
    expect(walked.S_infty[1]).toBe("lineage");
  });

  it("prefers an uncovered higher stratum over lower-stratum-only gain", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("binding", { bindings: [binding("alice")] }),
      candidate("prop-only", {
        bindings: [],
        propositions: [proposition("rel1")]
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("prop-only"), row("binding")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("binding");
  });

  it("is permutation-deterministic", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ]);
    const transfer = createQueryCompiledWalkTransfer(compiled);
    const forward = walkShadowCapture({
      candidates: [row("A"), row("B")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: transfer
    });
    const reverse = walkShadowCapture({
      candidates: [row("B"), row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: transfer
    });
    expect(isCapturedWalk(forward) && isCapturedWalk(reverse)).toBe(true);
    if (!isCapturedWalk(forward) || !isCapturedWalk(reverse)) throw new Error("expected");
    expect(forward.S_infty).toEqual(reverse.S_infty);
  });

  it("rejects a scoring-only migration that keeps live novelty admission", () => {
    const compiled = compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("core", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("lower", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      })
    ]);
    const compiledTransfer = createQueryCompiledWalkTransfer(compiled);
    const mixed: ShadowWalkUtilityTransfer = {
      ...compiledTransfer,
      admitLowerFrontier: LIVE_FACILITY_WALK_TRANSFER.admitLowerFrontier
    };
    expect(() => walkShadowCapture({
      candidates: [facilityRow("core", { a1: 1 }, 1), facilityRow("lower", { a2: 1 }, 2)],
      psi: psiFrom([["core", "lower"]]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: mixed
    })).toThrow(/live facility admission|live novelty admission/u);
    expect(() => assertUnmixedWalkTransfer(compiledTransfer, {
      answer_binding_position: 1,
      required_proposition_support: 0,
      certified_independent_support: 0
    }, {
      facility_keys: ["facility:a"],
      value_pairs: [],
      content_ids: []
    })).toThrow(/live novelty admission/u);
  });

  it("records a failed Decide_Q preview sidecar when the walk hits a Psi cycle", () => {
    const evidence = [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ];
    const compileInput = compileInputFor(scalarQuery(), evidence);
    const compiled = compileGamma(scalarQuery(), evidence);
    const world: QueryProofDecideWorldV1 = Object.freeze({
      compiled,
      compile_input: compileInput,
      candidates: [row("A"), row("B")],
      psi_edges: Object.freeze([["A", "B"], ["B", "A"]] as const),
      token_budget: 10,
      per_dimension_limits: null,
      unresolved_tradeoff_pairs: Object.freeze([]),
      answer_bindings: Object.freeze([])
    });
    const live = walkShadowCapture({
      candidates: [facilityRow("A", { a1: 1 }, 1), row("B", 1)],
      psi: (left: string, right: string) => left !== right,
      token_budget: 10,
      per_dimension_limits: null
    });
    expect(isCapturedWalk(live)).toBe(true);
    const preview = previewSidecar({ world }, 1);
    expect(preview.query_proof_preview?.status).toBe("failed");
    expect(preview.query_proof_preview?.contract_digest).toMatch(/^sha256:/u);
  });

  it("does not let unresolved trade-off fall through as a certified exact tie", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("A"), row("B")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      unresolved_tradeoff: () => true,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected");
    expect(walked.decisions[0]?.unresolved_pointwise_tradeoff).toBe(true);
  });

  it("lets a lower-frontier unique answer-binding enter without live novelty", () => {
    const compiled = compileGamma(distinctQuery(), [
      candidate("core", { bindings: [] }),
      candidate("lower", { bindings: [binding("bob")] })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("core", 1), row("lower", 2)],
      psi: psiFrom([["core", "lower"]]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty).toContain("lower");
    const lower = walked.decisions.find((decision) => decision.candidate_key === "lower");
    expect(lower?.named_novelty.compiled_atom_ids?.some((atomId) =>
      atomId.includes("bob"))).toBe(true);
    expect(lower?.named_novelty.facility_keys).toEqual([]);
  });

  it("does not let live facility novelty substitute for a unique compiled atom", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("core", { bindings: [binding("alice")] }),
      candidate("lower", { bindings: [binding("alice")] })
    ]);
    const walked = walkShadowCapture({
      candidates: [facilityRow("core", { a1: 1 }, 1), facilityRow("lower", { a2: 1 }, 2)],
      psi: psiFrom([["core", "lower"]]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("core");
    expect(walked.decisions[0]?.capture_reason).toBe("core_undominated");
    const lower = walked.decisions.find((decision) => decision.candidate_key === "lower");
    expect(lower?.capture_reason).not.toBe("cross_frontier_novelty");
    expect(lower?.named_novelty.facility_keys ?? []).toEqual([]);
    expect(lower?.named_novelty.compiled_atom_ids ?? []).toEqual([]);
  });

  it("prefers a resource-feasible higher stratum over a cheaper lower-stratum-only candidate", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("binding", { bindings: [binding("alice")], token_cost: 2 }),
      candidate("prop-only", {
        bindings: [],
        propositions: [proposition("rel1")],
        token_cost: 1
      })
    ]);
    const walked = walkShadowCapture({
      candidates: [
        { ...row("prop-only"), token_cost: 1 },
        { ...row("binding"), token_cost: 2 }
      ],
      psi: psiFrom([]),
      token_budget: 3,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured");
    expect(walked.S_infty[0]).toBe("binding");
  });

  it("rejects duplicate candidate_key and invalid token_cost on compiled and live walks", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const transfer = createQueryCompiledWalkTransfer(compiled);
    expect(() => walkShadowCapture({
      candidates: [row("A"), row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: transfer
    })).toThrow(/duplicate candidate_key/u);
    expect(() => walkShadowCapture({
      candidates: [row("A"), row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null
    })).toThrow(/duplicate candidate_key/u);
    for (const tokenCost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => walkShadowCapture({
        candidates: [{ ...row("A"), token_cost: tokenCost }],
        psi: psiFrom([]),
        token_budget: 10,
        per_dimension_limits: null,
        utility_transfer: transfer
      })).toThrow(ShadowContractError);
      expect(() => walkShadowCapture({
        candidates: [{ ...row("A"), token_cost: tokenCost }],
        psi: psiFrom([]),
        token_budget: 10,
        per_dimension_limits: null
      })).toThrow(ShadowContractError);
    }
  });

  it("rejects mixed live G fields with compiled G and mixed named novelty", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const walked = walkShadowCapture({
      candidates: [row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: createQueryCompiledWalkTransfer(compiled)
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected");
    expect(() => parseCaptureDecisionReceipt({
      ...walked.decisions[0]!,
      G: { ...walked.decisions[0]!.G, Values_v: 1 }
    })).toThrow(/mix live facility/u);
    expect(() => parseCaptureDecisionReceipt({
      ...walked.decisions[0]!,
      named_novelty: {
        facility_keys: ["facility:a"],
        value_pairs: [],
        content_ids: [],
        compiled_atom_ids: ["binding:scalar:x"]
      }
    })).toThrow(/cannot mix/u);
  });

  it("keeps permutation receipts identical including decisions", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ]);
    const transfer = createQueryCompiledWalkTransfer(compiled);
    const forward = walkShadowCapture({
      candidates: [row("A"), row("B")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: transfer
    });
    const reverse = walkShadowCapture({
      candidates: [row("B"), row("A")],
      psi: psiFrom([]),
      token_budget: 10,
      per_dimension_limits: null,
      utility_transfer: transfer
    });
    expect(isCapturedWalk(forward) && isCapturedWalk(reverse)).toBe(true);
    if (!isCapturedWalk(forward) || !isCapturedWalk(reverse)) throw new Error("expected");
    expect(forward.decisions).toEqual(reverse.decisions);
  });
});
