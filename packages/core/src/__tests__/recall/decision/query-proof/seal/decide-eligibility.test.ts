import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import {
  digestDecideConsumedIdentity,
  emptyWalkUtility,
  runQueryProofDecideQ,
  type QueryProofDecideWorldV1
} from "../../../../../recall/decision/query-proof/seal/decide.js";
import {
  decideWorldCapture,
  freezeDecideWorld
} from "../../../../../recall/decision/query-proof/seal/world-capture.js";
import {
  binding,
  candidate,
  compileGamma,
  compileInputFor,
  compilationFor,
  distinctQuery,
  hole,
  proposition,
  scalarQuery
} from "../gamma/gamma-fixture.js";

function worldFrom(
  evidence: ReturnType<typeof candidate>[],
  patch: Partial<QueryProofDecideWorldV1> = {},
  query = scalarQuery()
): QueryProofDecideWorldV1 {
  const compileInput = compileInputFor(query, evidence);
  const compiled = compileGamma(query, evidence);
  const keys = evidence.map((row) => row.candidate_key);
  return Object.freeze({
    compiled,
    compile_input: compileInput,
    candidates: keys.map((key) => Object.freeze({
      candidate_key: key,
      object_key: key,
      utility: emptyWalkUtility(key, key),
      h_eligible: true,
      token_cost: 1,
      dimension: "mem",
      static_frontier_index: null
    })),
    psi_edges: Object.freeze([] as const),
    token_budget: 10,
    per_dimension_limits: null,
    unresolved_tradeoff_pairs: Object.freeze([] as const),
    answer_bindings: keys.map((key) => Object.freeze({
      candidate_key: key,
      binding_id: `bind:${key}`,
      variable: "x",
      semantic_identity: key,
      value: key
    })),
    ...patch
  });
}

describe("Decide_Q eligibility and pack modes", () => {
  it("keeps unresolved in remaining while excluding only proved infeasible", () => {
    const decided = runQueryProofDecideQ(worldFrom([
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] }),
      candidate("dead", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      })
    ], {}, scalarQuery([{ id: "rel1", relation: "bought", arguments: ["x"] }])), 3);
    expect(decided.walk.S_infty).toContain("open");
    expect(decided.walk.S_infty).toContain("ok");
    expect(decided.walk.S_infty).not.toContain("dead");
    expect(decided.pack_mode).toBe("best_effort_uncertified");
  });

  it("does not certify a partial compilation with classified holes", () => {
    const query = scalarQuery();
    const evidence = [candidate("A", { bindings: [binding("alice")] })];
    const compilation = compilationFor(query, [hole("unknown_correlation")]);
    const world = worldFrom(evidence, {
      compiled: compileGamma(query, evidence, { compilation }),
      compile_input: compileInputFor(query, evidence, { compilation })
    }, query);
    const decided = runQueryProofDecideQ(world, 1);
    expect(world.compiled.compile_disposition).toBe("partial");
    expect(decided.disposition).toBe("best_effort");
    expect(decided.pack_mode).toBe("best_effort_uncertified");
  });

  it("abstains on an empty feasible prefix instead of defaulting certified", () => {
    const decided = runQueryProofDecideQ(worldFrom([
      candidate("dead", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      })
    ], {}, scalarQuery([{ id: "rel1", relation: "bought", arguments: ["x"] }])), 1);
    expect(decided.prefix).toEqual([]);
    expect(decided.disposition).toBe("abstained");
    expect(decided.pack_mode).toBe("abstained");
  });

  it("does not let identity break an unresolved trade-off", () => {
    const decided = runQueryProofDecideQ(worldFrom([
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("alice")] })
    ], {
      unresolved_tradeoff_pairs: [["A", "B"]],
      identity_tie_winner: "B"
    }), 2);
    expect(decided.disposition).toBe("conflict");
    expect(decided.pack_mode).toBe("conflict");
    expect(decided.unresolved_boundary_tradeoff).toBe(true);
  });

  it("fails closed on Proxy Decide_Q premises", () => {
    const world = worldFrom([candidate("A", { bindings: [binding("alice")] })]);
    const proxy = new Proxy(world, {
      get(target, property, receiver) {
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => runQueryProofDecideQ(proxy, 1)).toThrow(ShadowContractError);
    expect(() => runQueryProofDecideQ(proxy, 1)).toThrow(/proxies/u);
  });

  it("binds target prefix into the consumed identity digest", () => {
    const world = worldFrom([
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ]);
    const decided = runQueryProofDecideQ(world, 1);
    const other = digestDecideConsumedIdentity({
      world,
      prefix: ["B"],
      walk_transfer_digest: decided.decision_contract_digest,
      decision_contract_digest: decided.decision_contract_digest
    });
    expect(decided.decision_identity_digest).not.toBe(other);
  });

  it("binds standings, feasibility, atoms, source, and query into consumed identity", () => {
    const world = worldFrom([candidate("A", { bindings: [binding("alice")] })]);
    const decided = runQueryProofDecideQ(world, 1);
    const base = {
      prefix: decided.prefix,
      walk_transfer_digest: decided.decision_contract_digest,
      decision_contract_digest: decided.decision_contract_digest
    };
    const identity = digestDecideConsumedIdentity({ world, ...base });
    const standingPatch = Object.freeze({
      ...world,
      compiled: Object.freeze({
        ...world.compiled,
        standings: Object.freeze(world.compiled.standings.map((row) => Object.freeze({
          ...row,
          coverage: "does_not_cover" as const
        })))
      })
    });
    expect(standingPatch.compiled.gamma_digest).toBe(world.compiled.gamma_digest);
    expect(digestDecideConsumedIdentity({ world: standingPatch, ...base }))
      .not.toBe(identity);
    const feasibilityPatch = Object.freeze({
      ...world,
      compiled: Object.freeze({
        ...world.compiled,
        semantic_feasibility: Object.freeze(world.compiled.semantic_feasibility.map((row) =>
          Object.freeze({ ...row, semantic: "unresolved" as const })))
      })
    });
    expect(feasibilityPatch.compiled.gamma_digest).toBe(world.compiled.gamma_digest);
    expect(digestDecideConsumedIdentity({ world: feasibilityPatch, ...base }))
      .not.toBe(identity);
    const atomPatch = Object.freeze({
      ...world,
      compiled: Object.freeze({
        ...world.compiled,
        atoms: Object.freeze([])
      })
    });
    expect(digestDecideConsumedIdentity({ world: atomPatch, ...base })).not.toBe(identity);
    const sourcePatch = Object.freeze({
      ...world,
      compiled: Object.freeze({
        ...world.compiled,
        source_evidence_digest: world.compiled.query_digest
      })
    });
    expect(digestDecideConsumedIdentity({ world: sourcePatch, ...base })).not.toBe(identity);
    const queryPatch = Object.freeze({
      ...world,
      compiled: Object.freeze({
        ...world.compiled,
        query_digest: world.compiled.compilation_digest
      })
    });
    expect(digestDecideConsumedIdentity({ world: queryPatch, ...base })).not.toBe(identity);
  });

  it("does not treat freezeDecideWorld as an issued capture", () => {
    const world = worldFrom([candidate("A", { bindings: [binding("alice")] })]);
    const frozen = freezeDecideWorld(world);
    expect(decideWorldCapture(frozen)).toBeNull();
    expect(decideWorldCapture(world)).toBeNull();
  });

  it("marks unsupported query class before walking candidates", () => {
    const decided = runQueryProofDecideQ(worldFrom([
      candidate("A", { bindings: [binding("alice")] })
    ], {}, distinctQuery()), 1);
    expect(decided.disposition).toBe("unsupported");
    expect(decided.pack_mode).toBe("unsupported");
    expect(decided.prefix).toEqual([]);
    expect(decided.walk.S_infty).toEqual([]);
  });
});
