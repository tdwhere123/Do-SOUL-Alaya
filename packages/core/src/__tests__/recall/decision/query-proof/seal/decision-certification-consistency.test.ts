import { describe, expect, it } from "vitest";
import {
  runQueryProofDecideQ,
  emptyWalkUtility,
  type QueryProofDecideWorldV1
} from "../../../../../recall/decision/query-proof/seal/decide.js";
import {
  candidate,
  binding,
  proposition,
  scalarQuery,
  compileInputFor,
  compileGamma
} from "../gamma/gamma-fixture.js";
import type { CanonicalQueryV1 } from "../../../../../recall/query/canonical-query/index.js";
import type { QueryGammaCandidateEvidenceV1 } from "../../../../../recall/decision/query-proof/gamma/contract.js";
import type { QueryGammaCompileInputV1 } from "../../../../../recall/decision/query-proof/gamma/compile.js";

function worldOf(
  keys: readonly string[],
  compiled: ReturnType<typeof compileGamma>,
  compileInput: ReturnType<typeof compileInputFor>
): QueryProofDecideWorldV1 {
  return Object.freeze({
    compiled,
    compile_input: compileInput,
    candidates: keys.map((key) => Object.freeze({
      candidate_key: key,
      object_key: key,
      utility: emptyWalkUtility(key, key),
      h_eligible: true,
      token_cost: 1,
      dimension: "lexical",
      static_frontier_index: null
    })),
    psi_edges: Object.freeze([]),
    token_budget: 10,
    per_dimension_limits: null,
    unresolved_tradeoff_pairs: Object.freeze([]),
    answer_bindings: keys.map((key) => Object.freeze({
      candidate_key: key,
      binding_id: `binding-${key}`,
      variable: "x",
      semantic_identity: key,
      value: key
    }))
  });
}

function worldFromQuery(
  query: CanonicalQueryV1,
  evidence: readonly QueryGammaCandidateEvidenceV1[],
  extra: Partial<QueryGammaCompileInputV1> = {},
  patch: Partial<QueryProofDecideWorldV1> = {}
): QueryProofDecideWorldV1 {
  const compileInput = compileInputFor(query, evidence, extra);
  const compiled = compileGamma(query, evidence, extra);
  const keys = evidence.map((row) => row.candidate_key);
  return Object.freeze({
    ...worldOf(keys, compiled, compileInput),
    ...patch,
    compiled,
    compile_input: compileInput
  });
}

describe("decision and certification consistency", () => {
  it("excludes infeasible candidates from the walk remaining set for proved refutation", () => {
    const evidence = [
      candidate("refuted", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      }),
      candidate("ok", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "supports")]
      })
    ];
    const query = scalarQuery([{ id: "rel1", relation: "bought", arguments: ["x"] }]);
    const world = worldFromQuery(query, evidence);

    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.prefix).toEqual(["ok"]);
    expect(decided.walk.S_infty).not.toContain("refuted");
    expect(decided.disposition).toBe("captured");
    expect(decided.pack_mode).toBe("certified");
  });

  it("does not silently drop unresolved from remaining and does not certify them", () => {
    const evidence = [
      candidate("unresolved_cand", { bindings_status: "unknown" }),
      candidate("feasible_cand", { bindings: [binding("alice")] })
    ];
    const world = worldFromQuery(scalarQuery(), evidence);

    const decided = runQueryProofDecideQ(world, 2);
    expect(decided.walk.S_infty).toContain("unresolved_cand");
    expect(decided.walk.S_infty).toContain("feasible_cand");
    expect(decided.prefix).toContain("unresolved_cand");
    expect(decided.disposition).toBe("best_effort");
    expect(decided.pack_mode).toBe("best_effort_uncertified");
    expect(decided.pack_mode).not.toBe("certified");
  });

  it("produces conflict disposition when unresolved pointwise trade-off exists at decision boundary", () => {
    const evidence = [
      candidate("c1", { bindings: [binding("alice")] }),
      candidate("c2", { bindings: [binding("alice")] })
    ];
    const baseWorld = worldFromQuery(scalarQuery(), evidence);
    const worldWithTradeoff = {
      ...baseWorld,
      unresolved_tradeoff_pairs: [["c1", "c2"] as const]
    };

    const decided = runQueryProofDecideQ(worldWithTradeoff, 2);
    expect(decided.unresolved_boundary_tradeoff).toBe(true);
    expect(decided.disposition).toBe("conflict");
    expect(decided.pack_mode).toBe("conflict");
  });
});
