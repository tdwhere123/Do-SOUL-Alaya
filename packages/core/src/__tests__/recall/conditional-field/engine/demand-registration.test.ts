import { describe, expect, it } from "vitest";
import type { ObserverPage, QueryProgram } from "@do-soul/alaya-protocol";
import {
  adjacencyEffectsForRows,
  type AdjacencyRow
} from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import {
  applyObserverPage,
  createConditionalField,
  withdrawDerivationLeaves,
  type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import type { QueryInterpretation, SeedActivation } from "@do-soul/alaya-protocol";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import { encodeBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { defaultBudget, defaultView, productKey } from "../reference/deployment.fixture.js";
import { AS_OF, OPEN_GUARD, edge, facts, project, query, sequenceHyperedge } from "./relation-grounding.fixture.js";

const hop = (kind: string, source: string, target: string): QueryProgram => ({ schema_version: 1, kind: "relation",
  relation_kind: kind, source_variable: source, target_variable: target, facet_mode: "same_path",
  threshold_milligrades: 0, guard: OPEN_GUARD });
const PROGRAM: QueryProgram = { schema_version: 1, kind: "sequence", steps: [hop("r", "x", "m"), hop("s", "m", "y")] };
const KINDS = ["r", "s"];
const pair = (subject: string, predicate: string) => `${subject}\0${predicate}`;

function seededAt(objects: readonly string[]): FieldEngineState {
  const starts = seedProgramStates(PROGRAM);
  return createConditionalField({
    interpretation: query(PROGRAM),
    budget: defaultBudget({ work_units: 4_000_000, memory_bytes: 64_000_000, finalization_reserve: 0, min_envelope: 0 }),
    seeds: objects.flatMap((object) => starts.map((programState) => ({
      schema_version: 1, milligrades: 1000, state: productKey(object, "h0", "unbound", programState)
    })))
  });
}

function pageFor(state: FieldEngineState): ObserverPage {
  return { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}

function pass(
  state: FieldEngineState,
  rows: readonly AdjacencyRow[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  joinRows?: readonly AdjacencyRow[],
  allowance = 4_000_000
): FieldEngineState {
  let current = resumePathEffects({ ...state, remaining_exploration: allowance,
    remaining_memory_bytes: Math.max(state.remaining_memory_bytes, 32_000_000), memory_exhausted: false,
    retention_rejected: undefined,
    pending_path_effects: { offset: 0, retained_bytes: 0, page: pageFor(state), input: { rows, options: {
      interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts, physicalKinds: KINDS,
      liveStates: state.seen_identities, facets: state.facets, discoveries: state.discoveries,
      bindingContexts: state.binding_contexts,
      ...(joinRows === undefined ? {} : { joinRows })
    } } } });
  // An interrupted pass keeps its cursor; each resume gets a fresh allowance.
  for (let guard = 0; current.pending_path_effects !== undefined && guard < 10_000; guard += 1) {
    current = resumePathEffects({ ...current, remaining_exploration: allowance, memory_exhausted: false,
      retention_rejected: undefined });
  }
  return current;
}

const registered = (state: FieldEngineState) => {
  const keys: string[] = [];
  for (const key of state.pair_demands.keys()) keys.push(key);
  return keys.sort();
};

const olds = (count: number) => Array.from({ length: count }, (_, index) => `old${String(index)}`);
const ALL_FACTS = (count: number) => facts([...olds(count), "mid", "mid2", "end"]);

/** Work a later delta page spends against a field with `count` registered live states. */
function deltaPageWork(count: number): number {
  const sourceFacts = ALL_FACTS(count);
  const first = pass(seededAt(olds(count)), [], sourceFacts);
  const row = edge("r", "old0", "mid", "a1");
  const second = pass(first, [row], sourceFacts, [row], 4_000_000);
  expect(second.pending_path_effects).toBeUndefined();
  return 4_000_000 - second.remaining_exploration;
}

describe("live-state demand registration", () => {
  it("does not re-emit registered demands, so a delta page costs a fixed amount per unrelated old state", () => {
    const small = deltaPageWork(1), large = deltaPageWork(501);
    // Walk per old state: visit, advance, physical-kind candidate, origin entry, plus the prior-state facet scan.
    // Regenerating the registered demand would add its generation, replay and preparation units (11 per state).
    expect((large - small) / 500).toBeLessThanOrEqual(8);
  });

  it("emits a demand for a pair only while the registry does not hold it", () => {
    const state = pass(seededAt(olds(3)), [], ALL_FACTS(3));
    expect(registered(state)).toEqual(olds(3).map((object) => pair(object, "r")).sort());
    const input = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, physicalKinds: KINDS,
      liveStates: state.seen_identities };
    const demands = (options: object) => adjacencyEffectsForRows([], { ...input, ...options })
      .flatMap((effect) => effect.relation_demand === undefined ? [] : [pair(effect.relation_demand.subject, effect.relation_demand.predicate)]).sort();
    expect(demands({})).toEqual(registered(state));
    expect(demands({ registeredDemands: { pairs: state.pair_demands, sources: state.source_fact_demands } })).toEqual([]);
    const partial = { has: (key: string) => key === pair("old0", "r") };
    expect(demands({ registeredDemands: { pairs: partial, sources: state.source_fact_demands } }))
      .toEqual([pair("old1", "r"), pair("old2", "r")]);
  });

  it("registers a demand for a state first reached by a later page", () => {
    const sourceFacts = ALL_FACTS(2);
    const first = pass(seededAt(olds(2)), [], sourceFacts);
    const row = edge("r", "old0", "mid", "a1");
    const second = pass(first, [row], sourceFacts, [row]);
    expect(registered(second)).toEqual([...olds(2).map((object) => pair(object, "r")), pair("mid", "s")].sort());
  });
});

describe("registered demands under interruption, forks and withdrawal", () => {
  const rows = [edge("r", "old0", "mid", "a1"), edge("r", "old1", "mid2", "a2"), edge("s", "mid", "end", "b1")];

  function incremental(sourceFacts: ReadonlyMap<string, BoundSourceFacts>, allowance?: number): FieldEngineState {
    let state = pass(seededAt(olds(40)), [], sourceFacts, undefined, allowance);
    let population: AdjacencyRow[] = [];
    for (const page of [[rows[0]!], [rows[1]!, rows[2]!]]) {
      population = population.concat(page);
      state = pass(state, population, sourceFacts, population.length === page.length ? undefined : page, allowance);
    }
    return state;
  }

  it("resumes an interrupted pass to the same field and registry as an uninterrupted run", () => {
    const sourceFacts = ALL_FACTS(40);
    const whole = incremental(sourceFacts);
    const sliced = incremental(sourceFacts, 90);
    expect(sliced.pending_path_effects).toBeUndefined();
    expect(project(sliced)).toEqual(project(whole));
    expect(registered(sliced)).toEqual(registered(whole));
  });

  it("keeps sibling fields independent after a shared registered prefix", () => {
    const sourceFacts = ALL_FACTS(40);
    const base = pass(seededAt(olds(40)), [], sourceFacts);
    const before = registered(base);
    const left = pass(base, [rows[0]!], sourceFacts, [rows[0]!]);
    const right = pass(base, [rows[1]!], sourceFacts, [rows[1]!]);
    expect(registered(base)).toEqual(before);
    expect(registered(left)).toContain(pair("mid", "s"));
    expect(registered(left)).not.toContain(pair("mid2", "s"));
    expect(registered(right)).toContain(pair("mid2", "s"));
    expect(registered(right)).not.toContain(pair("mid", "s"));
    // A fresh run of the same single page lands on the same field as the fork.
    const fresh = pass(pass(seededAt(olds(40)), [], sourceFacts), [rows[1]!], sourceFacts, [rows[1]!]);
    expect(project(right)).toEqual(project(fresh));
  });

  it("re-derives a withdrawn state on a later page like a fresh rebuild", () => {
    const sourceFacts = ALL_FACTS(40);
    const first = pass(seededAt(olds(40)), [], sourceFacts);
    const withA1 = pass(first, [rows[0]!], sourceFacts, [rows[0]!]);
    const withdrawn = withdrawDerivationLeaves(withA1, "a1");
    // The same hop re-arrives under a new assertion, then the downstream row.
    const again = edge("r", "old0", "mid", "a1-again");
    const rederived = pass(pass(withdrawn, [again], sourceFacts, [again]), [again, rows[2]!], sourceFacts, [rows[2]!]);
    const fresh = pass(pass(pass(seededAt(olds(40)), [], sourceFacts), [again], sourceFacts, [again]),
      [again, rows[2]!], sourceFacts, [rows[2]!]);
    expect(project(rederived)).toEqual(project(fresh));
    expect(registered(rederived)).toEqual(expect.arrayContaining(registered(fresh)));
    expect(registered(rederived)).toContain(pair("mid", "s"));
  });
});

describe("skipped demand kinds", () => {
  const demandsFrom = (interpretation: QueryInterpretation, seeds: readonly SeedActivation[], extra: object) => {
    const field = createConditionalField({ interpretation, budget: defaultBudget({ finalization_reserve: 0, min_envelope: 0 }), seeds });
    return adjacencyEffectsForRows([], { interpretation, asOf: AS_OF, overlay: {}, physicalKinds: KINDS,
      liveStates: field.seen_identities, ...extra })
      .flatMap((effect) => effect.relation_demand === undefined ? [] : [pair(effect.relation_demand.subject, effect.relation_demand.predicate)]).sort();
  };
  const none = { has: () => false };
  const only = (...keys: string[]) => ({ has: (key: string) => keys.includes(key) });

  it("emits a claim demand unless both its pair and its source are registered", () => {
    const view = { ...defaultView(), claim_demands: [{ variable: "h", proposition_kind: "cause",
      argument_variables: ["c", "h"], required_claim: "supported" as const }] };
    const interpretation = query({ schema_version: 1, kind: "epsilon" }, { view });
    const binding = encodeBindingContext(new Map([["c", "a"], ["h", "a"]]));
    const seeds = [{ schema_version: 1 as const, milligrades: 1000, state: productKey("a", "h0", binding, "accepting") }];
    const claim = [pair("a", "cause")];
    expect(demandsFrom(interpretation, seeds, {})).toEqual(claim);
    expect(demandsFrom(interpretation, seeds, { registeredDemands: { pairs: only(claim[0]!), sources: none } })).toEqual(claim);
    expect(demandsFrom(interpretation, seeds, { registeredDemands: { pairs: none, sources: only("a") } })).toEqual(claim);
    expect(demandsFrom(interpretation, seeds, { registeredDemands: { pairs: only(claim[0]!), sources: only("a") } })).toEqual([]);
  });

  it("skips a routing demand only for a registered origin and routing predicate", () => {
    const seeds = ["o1", "o2"].map((object) => ({ schema_version: 1 as const, milligrades: 1000,
      state: productKey(object, "h0", "unbound", seedProgramStates(PROGRAM)[0]!) }));
    const overlay = { rt: { applicable: true, role: "routing_only" } };
    const routing = [pair("o1", "rt"), pair("o2", "rt")];
    const withR = (registered: string[]) => demandsFrom(query(PROGRAM), seeds,
      { overlay, registeredDemands: { pairs: only(...registered), sources: none } }).filter((key) => key.endsWith("\0rt"));
    expect(withR([])).toEqual(routing);
    expect(withR([routing[0]!])).toEqual([routing[1]!]);
    expect(withR(routing)).toEqual([]);
  });

  it.each([
    ["a relation premise", { schema_version: 1, kind: "hyperedge", join: "and",
      premises: [hop("r", "x", "m"), hop("s", "x", "y")] } as QueryProgram],
    ["a sequence premise", sequenceHyperedge([hop("r", "x", "m"), hop("s", "m", "y")])]
  ])("skips a registered hyperedge demand for %s", (_name, program) => {
    const seeds = seedProgramStates(program).map((programState) => ({ schema_version: 1 as const, milligrades: 1000,
      state: productKey("o1", "h0", "unbound", programState) }));
    const interpretation = query(program);
    const open = demandsFrom(interpretation, seeds, {});
    expect(open).toContain(pair("o1", "r"));
    const skipped = demandsFrom(interpretation, seeds, { registeredDemands: { pairs: only(pair("o1", "r")), sources: none } });
    expect(skipped).not.toContain(pair("o1", "r"));
    expect(skipped).toEqual(open.filter((key) => key !== pair("o1", "r")));
  });

  it("leaves the field unchanged when a chunk holds no effects or only payload-free demand effects", () => {
    const base = seededAt(olds(3));
    const demands = olds(3).map((object) => ({ observation_id: `demand:${object}:r`,
      relation_demand: { subject: object, predicate: "r" } }));
    const empty = applyObserverPage(base, { page: pageFor(base), effects: [] });
    const absorbed = applyObserverPage(base, { page: pageFor(base), effects: demands });
    expect(project(absorbed)).toEqual(project(empty));
    expect(absorbed.seen_identities.length).toBe(empty.seen_identities.length);
    expect(absorbed.facets).toEqual(empty.facets);
    expect(absorbed.discoveries).toEqual(empty.discoveries);
    expect(absorbed.observations.length).toBe(empty.observations.length);
    expect(absorbed.remaining_memory_bytes).toBe(empty.remaining_memory_bytes);
  });
});
