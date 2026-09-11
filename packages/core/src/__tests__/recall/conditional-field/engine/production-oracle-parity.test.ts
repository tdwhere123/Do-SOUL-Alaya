import { describe, expect, it } from "vitest";
import { evaluateBooleanHypergraph, type BooleanHyperedge } from "@do-soul/alaya-graph-algorithms";
import { productSubjectId, type ObserverPage, type QueryInterpretation, type QueryProgram, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { applyObserverPage, createConditionalField, withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { bindEngineState } from "../../../../recall/conditional-field/engine/field-update.js";
import { adjacencyEffectsForRows, seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition.js";
import { encodeBindingContext, parseBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const validity: Transition["validity"] = { kind: "open", valid_from: "2026-01-01T00:00:00Z" };
function interpretation(program: QueryProgram): QueryInterpretation {
  return { schema_version: 1, query_id: "oracle-parity", snapshot_id: SNAPSHOT_ID, status: "resolved", program,
    view: defaultView(), holes: [], hypotheses: [] };
}
function page(): ObserverPage {
  return { schema_version: 1, query_id: "oracle-parity", snapshot_id: SNAPSHOT_ID,
    cursor: { schema_version: 1, cursor_id: "page", query_id: "oracle-parity", snapshot_id: SNAPSHOT_ID,
      region_id: "adjacency", position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}
function settle(initial: FieldEngineState, allowance: number): FieldEngineState {
  let state = initial;
  for (let attempt = 0; attempt < 10_000 && state.closure.propagation !== "fixed_point"; attempt += 1) {
    const { binding, closure: _closure, ...rest } = state;
    state = bindEngineState({ ...rest, proven_binding: binding, remaining_exploration: allowance });
    expect(state.remaining_exploration).toBeGreaterThanOrEqual(0);
    expect((state.solver_completed_work ?? 0) - (rest.solver_completed_work ?? 0)).toBeLessThanOrEqual(allowance);
  }
  expect(state.closure.propagation).toBe("fixed_point");
  return state;
}
function reachable(state: FieldEngineState, acceptingOnly = false): Map<string, number> {
  if (state.binding.kind !== "bound") throw new Error("expected a bound field");
  const rows = state.binding.snapshot.values.filter((row) => row.milligrades !== undefined && (!acceptingOnly || row.accepting));
  for (const row of rows) expect(state.binding.guaranteed_values?.get(productStateNodeId(row.state))).toBe(row.milligrades);
  return new Map(rows.map((row) => [productSubjectId(row.state), row.milligrades!]));
}
function oracle(nodeIds: string[], seeds: ReadonlyMap<string, number>, edges: BooleanHyperedge[]) {
  return evaluateBooleanHypergraph({ nodeIds, seeds, edges, bottom: 0, top: 1000 });
}

describe("production fixed point against independent Boolean hypergraph closure", () => {
  it.each([1, 3, 11])("preserves zero, pending seeds, alternatives and SCC withdrawal with allowance %s", (allowance) => {
    const edges: BooleanHyperedge[] = [
      { kind: "unary", from: "strong", to: "a", strength: 850 },
      { kind: "unary", from: "weak", to: "a", strength: 350 },
      { kind: "identity", from: "a", to: "b" }, { kind: "identity", from: "b", to: "a" },
      { kind: "identity", from: "zero", to: "zero-end" },
      { kind: "identity", from: "pending", to: "late-end" },
      { kind: "identity", from: "unsupported-a", to: "unsupported-b" },
      { kind: "identity", from: "unsupported-b", to: "unsupported-a" }
    ];
    const nodeIds = [...new Set(edges.flatMap((edge) => [edge.from as string, edge.to]))];
    const seeds = new Map([["strong", 900], ["weak", 600], ["zero", 0]]);
    const transitions: Transition[] = edges.map((edge, index) => ({ schema_version: 1,
      from: productKey(edge.from as string), to: productKey(edge.to), applicable: true, validity,
      relation_kind: `edge-${index}`, strength_milligrades: edge.kind === "identity" ? 1000 : 850 }));
    transitions[1] = { ...transitions[1]!, strength_milligrades: 350 };
    const makeSeed = (id: string, milligrades: number): SeedActivation => ({ schema_version: 1, state: productKey(id), milligrades });
    for (const order of [transitions, [...transitions].reverse()]) {
      let state = createConditionalField({ interpretation: interpretation({ schema_version: 1, kind: "epsilon" }),
        budget: defaultBudget({ work_units: nodeIds.length + 1, finalization_reserve: 0, min_envelope: 0 }),
        seeds: [...seeds].map(([id, grade]) => makeSeed(id, grade)), transitions: order });
      expect(state.closure.propagation).toBe("open");
      state = settle(state, allowance);
      expect(reachable(state)).toEqual(oracle(nodeIds, seeds, edges));
      expect(reachable(state).get("zero-end")).toBe(0);
      expect(reachable(state).has("late-end")).toBe(false);
      state = applyObserverPage({ ...state, remaining_exploration: 100 }, {
        page: { ...page(), observations: [{ schema_version: 1, observation_id: "late-seed", object_id: "pending",
          source_revision: "rev", workspace_id: "ws", association_milligrades: 700,
          applicability: { schema_version: 1, kind: "query_predicate", verdict: "true" } }] },
        effects: [{ observation_id: "late-seed", seed: makeSeed("pending", 700), admitted_seed: true }] });
      const lateSeeds = new Map([...seeds, ["pending", 700]]);
      state = settle(state, allowance);
      expect(reachable(state)).toEqual(oracle(nodeIds, lateSeeds, edges));
      for (const removed of ["strong", "weak"]) {
        state = settle(withdrawDerivationLeaves({ ...state, remaining_exploration: allowance }, productStateNodeId(productKey(removed))), allowance);
        lateSeeds.delete(removed);
        expect(reachable(state)).toEqual(oracle(nodeIds, lateSeeds, edges));
        expect(reachable(state).get("a")).toBe(removed === "strong" ? 350 : undefined);
      }
    }
  });

  it.each([1, 2, 20])("grounds AND per binding and hypothesis across relation page width %s", (width) => {
    const relation = (relation_kind: string): QueryProgram => ({ schema_version: 1, kind: "relation", relation_kind,
      source_variable: "x", target_variable: "y", guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" },
      facet_mode: "same_path", threshold_milligrades: 0 });
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [relation("left"), relation("right")] };
    const query = interpretation(program);
    const sources = [{ id: "source;=one", grade: 900, hypothesis: "h0" }, { id: "source-two", grade: 600, hypothesis: "h1" },
      { id: "source-zero", grade: 0, hypothesis: "h0" }];
    const rows = sources.flatMap((source) => [
      { sourceObjectId: source.id, targetObjectId: "shared", predicate: "left", assertionId: `${source.id}-left`, validity },
      { sourceObjectId: source.id, targetObjectId: "shared", predicate: "right", assertionId: `${source.id}-right`, validity },
      { sourceObjectId: source.id, targetObjectId: "incompatible-left", predicate: "left", assertionId: `${source.id}-only-left`, validity },
      { sourceObjectId: source.id, targetObjectId: "incompatible-right", predicate: "right", assertionId: `${source.id}-only-right`, validity }
    ]);
    const seeds: SeedActivation[] = sources.flatMap((source) => seedProgramStates(program).map((programState) => ({
      schema_version: 1, state: productKey(source.id, source.hypothesis, encodeBindingContext(new Map([["x", source.id]])), programState),
      milligrades: source.grade
    })));
    const facts = new Map(rows.flatMap((row) => [row.sourceObjectId, row.targetObjectId]).map((object_id) => [object_id, { object_id, source_revision: "rev" }]));
    const outputId = (source: typeof sources[number], target: string) => JSON.stringify([source.id, source.hypothesis, target]);
    function expected(available: typeof rows) {
      const nodeIds: string[] = [], edges: BooleanHyperedge[] = [], oracleSeeds = new Map<string, number>(), outputs = new Set<string>();
      for (const source of sources) {
        const seedId = JSON.stringify([source.id, source.hypothesis]);
        nodeIds.push(seedId); oracleSeeds.set(seedId, source.grade);
        for (const target of ["shared", "incompatible-left", "incompatible-right"]) {
          const output = outputId(source, target), left = `${output}:left`, right = `${output}:right`;
          outputs.add(output);
          nodeIds.push(output, left, right);
          for (const [predicate, leg] of [["left", left], ["right", right]]) {
            if (available.some((row) => row.sourceObjectId === source.id && row.targetObjectId === target && row.predicate === predicate)) {
              edges.push({ kind: "identity", from: seedId, to: leg! });
            }
          }
          edges.push({ kind: "and", from: [left, right], to: output, strength: 1000 });
        }
      }
      return new Map([...oracle(nodeIds, oracleSeeds, edges)].filter(([id]) => outputs.has(id)));
    }
    for (const order of [rows, [...rows].reverse()]) {
      let state = createConditionalField({ interpretation: query, budget: defaultBudget(), seeds });
      for (let end = width; end < rows.length + width; end += width) {
        const available = order.slice(0, end);
        state = settle(applyObserverPage({ ...state, remaining_exploration: 10_000 }, { page: page(),
          effects: adjacencyEffectsForRows(available, { interpretation: query, asOf: "2026-09-09T00:00:00Z",
            liveStates: state.seen_identities, overlay: { left: { milligrades: 1000, applicable: true }, right: { milligrades: 1000, applicable: true } },
            sourceFacts: facts }) }), 3);
        if (state.binding.kind !== "bound") throw new Error("field rejected");
        const actual = new Map(state.binding.snapshot.values.filter((value) => value.accepting && value.milligrades !== undefined)
          .map((value) => [JSON.stringify([parseBindingContext(value.state.binding_context).get("x"), value.state.hypothesis_id,
            productSubjectId(value.state)]), value.milligrades!]));
        expect(actual).toEqual(expected(available));
      }
    }
  });
});
