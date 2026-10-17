import { expect, it } from "vitest";
import { productEndpointId, type ObserverPage, type ProductStateKey } from "@do-soul/alaya-protocol";
import { createConditionalField, withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { bindEngineState } from "../../../../recall/conditional-field/engine/field-update.js";
import { indexedIdentityWork, settledEndpointIndex } from "../../../../recall/conditional-field/engine/state-endpoint-index.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import { facetIdentityIndexOf } from "../../../../recall/conditional-field/engine/field-retention-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { defaultBudget, productKey } from "../reference/deployment.fixture.js";
import { AS_OF, edge, storedFacts, project, query, relation } from "./relation-grounding.fixture.js";

const PROGRAM = relation("p");
const AUTOMATON = compileProgramAutomaton(PROGRAM);
const OVERLAY = {};
const KINDS = ["p"];
const START = seedProgramStates(PROGRAM)[0]!;
const key = (id: string, hypothesis = "h0") => productKey(id, hypothesis, "unbound", START);
type Row = ReturnType<typeof edge>;

function seeded(states: readonly ProductStateKey[]): FieldEngineState {
  const initial = createConditionalField({ interpretation: query(PROGRAM),
    budget: defaultBudget({ work_units: 1_000_000, memory_bytes: 64_000_000, finalization_reserve: 0, min_envelope: 0 }),
    seeds: states.map(state => ({ schema_version: 1, state, milligrades: 1000 }))
  });
  const { binding, ...rest } = initial;
  return bindEngineState({ ...rest, proven_binding: binding, compiled_automaton: AUTOMATON,
    identity_index: undefined, ordered_identities: undefined, identity_positions: undefined });
}

function pending(state: FieldEngineState, rows: readonly Row[], joinRows?: readonly Row[]) {
  const page: ObserverPage = { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
  return { offset: 0, retained_bytes: 0, page, input: { rows, options: {
    interpretation: state.interpretation, asOf: AS_OF, overlay: OVERLAY, physicalKinds: KINDS,
    liveStates: state.seen_identities, sourceFacts: state.source_facts,
    facets: state.facets, facetIndex: facetIdentityIndexOf(state), discoveries: state.discoveries,
    compiledAutomaton: AUTOMATON, bindingContexts: state.binding_contexts,
    ...(joinRows === undefined ? {} : { joinRows })
  } } };
}

function settled(count = 20) {
  const ids = Array.from({ length: count }, (_, index) => `old${String(index)}`);
  // Same immutable fact snapshot across the settled pass and later row delta.
  const sourceFacts = storedFacts([...ids, "T", "U"]);
  const state = { ...seeded(ids.map(id => key(id))), source_facts: sourceFacts };
  const input = pending(state, []);
  const result = resumePathEffects({ ...state, pending_path_effects: { ...input,
    input: { ...input.input, options: { ...input.input.options, sourceFacts } } } });
  expect(result.pending_path_effects).toBeUndefined();
  return { state: result, sourceFacts };
}

function withFacts(state: FieldEngineState, rows: readonly Row[], sourceFacts: ReadonlyMap<string, BoundSourceFacts>) {
  const next = pending(state, rows, rows);
  return { ...next, input: { ...next.input, options: { ...next.input.options, sourceFacts } } };
}

it("indexes same-endpoint hypotheses in admitted identity order and isolates appended forks", () => {
  const states = [key("A", "h0"), key("A", "h1"), key("B", "h0")];
  const base = seeded(states);
  const index = base.state_endpoint_index!;
  expect(index.rows).toBe(base.seen_identities);
  expect([...index.endpoints.get(productEndpointId(states[0]!))!]).toEqual(states.slice(0, 2));
  expect([...index.endpoints.get(productEndpointId(states[2]!))!]).toEqual([states[2]]);
  const append = (state: ProductStateKey) => {
    const { binding, ...rest } = base;
    return bindEngineState({ ...rest, proven_binding: binding, identity_spool: [state] });
  };
  const left = append(key("A", "h2")), right = append(key("C"));
  expect(left.state_endpoint_index!.endpoints.get(productEndpointId(states[0]!))!.length).toBe(3);
  expect(right.state_endpoint_index!.endpoints.get(productEndpointId(states[0]!))!.length).toBe(2);
  expect(index.endpoints.size).toBe(2);
  expect(index.endpoints.has(productEndpointId(key("C")))).toBe(false);
});

it("leaves raw fields and preexisting unindexed identities on the charged scan fallback", () => {
  const raw = createConditionalField({ interpretation: query(PROGRAM), budget: defaultBudget(),
    seeds: [{ schema_version: 1, state: key("A"), milligrades: 1000 }] });
  expect(raw.state_endpoint_index).toBeUndefined();
  expect(indexedIdentityWork(raw)).toBe(1);
  const { binding, ...rest } = raw;
  const late = bindEngineState({ ...rest, proven_binding: binding, compiled_automaton: AUTOMATON,
    identity_spool: [key("B")] });
  expect(late.seen_identities.length).toBe(2);
  expect(late.state_endpoint_index).toBeUndefined();
  expect(indexedIdentityWork(late)).toBe(1);
  for (const state of [raw, late, seeded([])]) {
    const settled = resumePathEffects({ ...state, pending_path_effects: pending(state, []) });
    expect(settled.path_effect_frontier?.demand_context).toBeUndefined();
  }
});

it("charges index construction with the identity and rejects a partial memory admission", () => {
  const base = seeded([]), added = key("A");
  const needed = Buffer.byteLength(JSON.stringify(added), "utf8") + 32 + productStateNodeId(added).length
    + 128 + 112 + 2 * productEndpointId(added).length;
  const append = (memory: number, work = 1000) => {
    const { binding, ...rest } = base;
    return bindEngineState({ ...rest, proven_binding: binding, identity_spool: [added],
      remaining_exploration: work, remaining_memory_bytes: memory });
  };
  const exact = append(needed);
  expect(exact.state_endpoint_index!.endpoints.get(productEndpointId(added))!.at(0)).toEqual(added);
  expect(exact.remaining_memory_bytes).toBe(0);
  expect(exact.admitted_allocation_bytes - base.admitted_allocation_bytes).toBe(needed);
  const short = append(needed - 1);
  expect(short.state_endpoint_index!.endpoints.size).toBe(0);
  expect(short.seen_identities.length).toBe(0);
  expect(short.memory_exhausted).toBe(true);
  const interrupted = append(needed, 1);
  expect(interrupted.state_endpoint_index!.endpoints.size).toBe(0);
  expect(interrupted.identity_spool.length).toBe(1);
});

it("requires a settled exact-context delta and refuses changed facts, suffixes and hyperedges", () => {
  const { state, sourceFacts } = settled();
  const row = edge("p", "old0", "T", "p-T");
  const input = withFacts(state, [row], sourceFacts);
  const checked = { ...input, population_checked: true };
  expect(settledEndpointIndex(state, checked)).toBe(state.state_endpoint_index);
  expect(settledEndpointIndex(state, input)).toBe(state.state_endpoint_index);
  const options = input.input.options;
  const changedFacts = { ...input, input: { ...input.input, options: { ...options, sourceFacts: new Map(sourceFacts) } } };
  expect(settledEndpointIndex(state, changedFacts)).toBeUndefined();
  expect(settledEndpointIndex(state, { ...changedFacts, population_checked: true })).toBe(state.state_endpoint_index);
  for (const change of [
    { overlay: {} }, { physicalKinds: [...KINDS] }, { interpretation: { ...state.interpretation } },
    { liveStates: [...state.seen_identities] }, { liveStateOffset: 1 }, { joinRows: undefined },
    { discoveries: [...state.discoveries, { subject_id: "new", source_id: "old0", predicate: "p", assertion_id: "new" }] },
    { compiledAutomaton: compileProgramAutomaton({ schema_version: 1, kind: "hyperedge", join: "and", premises: [PROGRAM] }) }
  ]) {
    expect(settledEndpointIndex(state, { ...checked, input: { ...input.input,
      options: { ...options, ...change } } })).toBeUndefined();
  }
});

it("joins a later row without scanning unrelated settled states and preserves the full-pass result", () => {
  const measure = (count: number) => {
    const { state, sourceFacts } = settled(count);
    const row = edge("p", "old0", "T", "p-T");
    const input = { ...withFacts(state, [row], sourceFacts), population_checked: true };
    const indexed = resumePathEffects({ ...state, remaining_exploration: 1_000_000, pending_path_effects: input });
    const fallback = resumePathEffects({ ...state, remaining_exploration: 1_000_000,
      path_effect_frontier: undefined, pending_path_effects: input });
    expect(project(indexed).transitions).toHaveLength(1);
    expect(project(indexed)).toEqual(project(fallback));
    return { indexWork: 1_000_000 - indexed.remaining_exploration,
      fallbackWork: 1_000_000 - fallback.remaining_exploration };
  };
  const small = measure(1), large = measure(100);
  expect(large.fallbackWork - large.indexWork).toBeGreaterThan(small.fallbackWork - small.indexWork + 200);
});

it("resumes an indexed cursor and restores withdrawal results to an independent fresh pass", () => {
  const { state, sourceFacts } = settled();
  const rows = [edge("p", "old0", "T", "p-T"), edge("p", "old0", "U", "p-U")];
  const input = { ...withFacts(state, rows, sourceFacts), population_checked: true };
  const full = resumePathEffects({ ...state, pending_path_effects: input });
  expect(project(full).transitions).toHaveLength(2);
  const partial = resumePathEffects({ ...state, remaining_exploration: 10, pending_path_effects: input });
  expect(partial.pending_path_effects).toBeDefined();
  expect(partial.pending_path_effects!.input.options.settledStateEndpoints).toBe(state.state_endpoint_index);
  const resumed = resumePathEffects({ ...partial, remaining_exploration: 1_000_000 });
  expect(project(resumed)).toEqual(project(full));
  const withdrawn = withdrawDerivationLeaves(partial, "p-T");
  expect(withdrawn.pending_path_effects!.input.options.settledStateEndpoints).toBeUndefined();
  const restored = resumePathEffects({ ...withdrawn, remaining_exploration: 1_000_000 });
  const freshInput = withFacts(state, [rows[1]!], sourceFacts);
  const fresh = resumePathEffects({ ...state, pending_path_effects: freshInput });
  expect(project(restored)).toEqual(project(fresh));
  expect(project(state).transitions).toEqual([]);
});
