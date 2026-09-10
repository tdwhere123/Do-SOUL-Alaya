import { describe, expect, it } from "vitest";
import { solveMaxMinField } from "@do-soul/alaya-graph-algorithms";
import { type Derivation, type ObserverPage, type QueryInterpretation, type QueryProgram, type Transition } from "@do-soul/alaya-protocol";
import { applyObserverPage, createConditionalField, withdrawDerivationLeaves } from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { derivationForest, evaluateDerivation, leafDerivation, seedDerivationIdentity } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { adjacencyEffectsForRows, seedProgramStates, transitionKey } from "../../../../recall/conditional-field/engine/path-composition.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { localLeafIds, traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

function interpretation(): QueryInterpretation {
  return { schema_version: 1, query_id: "dependency-boundary", snapshot_id: SNAPSHOT_ID,
    status: "resolved", program: { schema_version: 1, kind: "epsilon" }, view: defaultView(), holes: [], hypotheses: [] };
}

function edge(from: string, to: string, kind: string, grade = 900): Transition {
  return { schema_version: 1, from: productKey(from), to: productKey(to), relation_kind: kind,
    strength_milligrades: grade, applicable: true,
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
}

function page(id: string): ObserverPage {
  return { schema_version: 1, query_id: "dependency-boundary", snapshot_id: SNAPSHOT_ID,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", snapshot_id: SNAPSHOT_ID,
      query_id: "dependency-boundary", position: id, committed_through: id },
    observations: [], outcome: { schema_version: 1, status: "open" }, open_regions: [] };
}

function leafGrades(rows: readonly Derivation[]): Map<string, number> {
  return new Map(rows.filter((row) => row.kind === "leaf" && row.association_milligrades !== undefined)
    .flatMap((row) => row.leaf_ids.map((id) => [id, row.association_milligrades!] as const)));
}

describe("dependency boundary regressions", () => {
  it("shares compatible AND alternatives instead of materializing their Cartesian product", () => {
    const premise = (kind: string): QueryProgram => ({ schema_version: 1, kind: "relation", relation_kind: kind,
      source_variable: "x", target_variable: "y", guard: { schema_version: 1, kind: "query_predicate", verdict: "true" },
      facet_mode: "same_path", threshold_milligrades: 0 });
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [premise("p"), premise("q")] };
    const rows = ["p", "q"].flatMap((predicate) => Array.from({ length: 10 }, (_, index) => ({
      assertionId: `${predicate}-${index}`, sourceObjectId: "a", targetObjectId: "b", predicate,
      source_revision: "rev", validity: edge("a", "b", predicate).validity
    })));
    const effects = adjacencyEffectsForRows(rows, { interpretation: { ...interpretation(), program }, asOf: "2026-09-10T00:00:00.000Z",
      liveStates: [productKey("a", "h0", "default", seedProgramStates(program)[0]!)],
      sourceFacts: new Map([["a", { object_id: "a", source_revision: "rev" }], ["b", { object_id: "b", source_revision: "rev" }]]),
      overlay: { p: { milligrades: 900, applicable: true }, q: { milligrades: 900, applicable: true } } });
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.length).toBeLessThanOrEqual(rows.length);
  });

  it("bounds outgoing relaxation work inside a high fan-out node", () => {
    const nodes = ["root", ...Array.from({ length: 100 }, (_, index) => `leaf-${index}`)];
    const solved = solveMaxMinField({ nodeIds: nodes, seeds: new Map([["root", 1000]]), bottom: 0, top: 1000,
      transitions: nodes.slice(1).map((to) => ({ from: "root", to, strength: 900 })), workLimit: 1 });
    expect(solved.values.size).toBeLessThanOrEqual(2);
    expect(solved.complete).toBe(false);
  });

  it("grounds each cyclic witness in an external seed and preserves its bottleneck", () => {
    const seeds = [{ schema_version: 1 as const, state: productKey("a"), milligrades: 500 }];
    const transitions = [edge("a", "b", "ab"), edge("b", "c", "bc"), edge("c", "a", "ca")];
    const grounded = groundedOutputDerivations({ seeds, transitions, derivations: [], transition_derivations: {}, allowance: 1000 });
    const root = grounded.roots[productStateNodeId(productKey("c"))]?.[0];
    expect(root).toBeDefined();
    expect(evaluateDerivation(derivationForest(grounded.derivations), root!, leafGrades(grounded.derivations))).toBe(500);
    const forest = derivationForest(grounded.derivations);
    expect(localLeafIds(traceDerivationForest({ forest, roots: [root!] }).traversal)).toContain(seedDerivationIdentity(productStateNodeId(productKey("a"))));
  });

  it("does not materialize a witness for an unseeded hard cycle", () => {
    const grounded = groundedOutputDerivations({ seeds: [], transitions: [edge("a", "b", "ab"), edge("b", "a", "ba")],
      derivations: [], transition_derivations: {}, allowance: 1000 });
    expect(Object.keys(grounded.roots)).toEqual([]);
  });

  it("preserves independent assertions arriving on different observer pages", () => {
    const start = createConditionalField({ interpretation: interpretation(), budget: defaultBudget(),
      seeds: [{ schema_version: 1, state: productKey("a"), milligrades: 1000 }] });
    const first = applyObserverPage(start, { page: page("one"), effects: [{ observation_id: "effect-one",
      transition: edge("a", "b", "same-predicate", 900), derivation: leafDerivation({ derivation_id: "rule-one",
        observation_id: "assertion-one", leaf_id: "assertion-one", association_milligrades: 900 }) }] });
    const second = applyObserverPage(first, { page: page("two"), effects: [{ observation_id: "effect-two",
      transition: edge("a", "b", "same-predicate", 200), derivation: leafDerivation({ derivation_id: "rule-two",
        observation_id: "assertion-two", leaf_id: "assertion-two", association_milligrades: 200 }) }] });
    expect(second.binding.kind).toBe("bound");
    if (second.binding.kind !== "bound") return;
    expect(second.binding.values.get(productStateNodeId(productKey("b")))).toBe(900);
    const after = withdrawDerivationLeaves(second, "assertion-one");
    if (after.binding.kind !== "bound") throw new Error("withdrawal rejected");
    expect(after.binding.values.get(productStateNodeId(productKey("b")))).toBe(200);
  });

  it("includes validity in retained semantic rule identity", () => {
    const original = edge("a", "b", "same-predicate");
    const changed = { ...original, validity: { kind: "open" as const, valid_from: "2026-08-01T00:00:00.000Z" } };
    expect(transitionKey(original)).not.toBe(transitionKey(changed));
  });

  it("updates a disjoint addition without re-solving an unaffected chain", () => {
    const transitions = Array.from({ length: 30 }, (_, index) => edge(`n${index}`, `n${index + 1}`, `e${index}`));
    const before = createConditionalField({ interpretation: interpretation(), budget: defaultBudget(),
      seeds: [{ schema_version: 1, state: productKey("n0"), milligrades: 1000 }], transitions });
    const after = applyObserverPage(before, { page: page("new"), effects: [{ observation_id: "new-seed",
      seed: { schema_version: 1, state: productKey("disjoint"), milligrades: 1000 } }] });
    if (after.binding.kind !== "bound") throw new Error("addition rejected");
    expect(after.binding.values.get(productStateNodeId(productKey("n30")))).toBe(900);
    expect(after.binding.solver_steps).toBeLessThanOrEqual(4);
  });

  it("does not inspect old edge fields or replay the retained queue during a disjoint addition", () => {
    let oldReads = 0;
    const original = edge("a", "b", "old");
    const tracked: Transition = { ...original,
      get from() { oldReads += 1; return original.from; },
      get to() { oldReads += 1; return original.to; },
      get strength_milligrades() { oldReads += 1; return original.strength_milligrades; } };
    const before = createConditionalField({ interpretation: interpretation(), budget: defaultBudget(),
      seeds: [{ schema_version: 1, state: productKey("a"), milligrades: 1000 }], transitions: [tracked] });
    oldReads = 0;
    const after = applyObserverPage(before, { page: page("disjoint"), effects: [{ observation_id: "disjoint-seed",
      seed: { schema_version: 1, state: productKey("disjoint"), milligrades: 400 } }] });
    expect(oldReads).toBe(0);
    if (after.binding.kind !== "bound" || before.binding.kind !== "bound") throw new Error("expected bound fields");
    expect(after.binding.values.get(productStateNodeId(productKey("b")))).toBe(900);
    expect(before.binding.values.has(productStateNodeId(productKey("disjoint")))).toBe(false);
    expect(after.binding.values.get(productStateNodeId(productKey("disjoint")))).toBe(400);
  });

  it("invalidates a claim when its supporting dependency is withdrawn", () => {
    const a = productKey("a");
    const b = productKey("b");
    const before = createConditionalField({ interpretation: interpretation(), budget: defaultBudget(),
      seeds: [{ schema_version: 1, state: a, milligrades: 1000 }, { schema_version: 1, state: b, milligrades: 100 }],
      transitions: [edge("a", "b", "ab")],
      claims: new Map([["b", "supported"]]),
      support: [{ schema_version: 1, proposition_id: "b", claim: "supported",
        witnesses: [{ schema_version: 1, witness_id: "a-supports-b", premises: [productStateNodeId(a)], cost: 1, complete: true }] }] });
    const after = withdrawDerivationLeaves(before, seedDerivationIdentity(productStateNodeId(a)));
    expect(after.support).toEqual([]);
    expect(after.claims.get("b") ?? "unknown").toBe("unknown");
  });
});
