import { describe, expect, it } from "vitest";
import {
  productSubjectId,
  type Guard,
  type ObserverPage,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import {
  adjacencyEffectsForRows,
  createAdjacencyEffectCursor,
  type AdjacencyRow
} from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import {
  composedFacetPathId,
  extendFacets,
  facetBelongsToOutput,
  PathFacetLookup,
  samePathAccepts
} from "../../../../recall/conditional-field/engine/path-composition-facet.js";
import { observedTargetRevision } from "../../../../recall/conditional-field/engine/path-matching.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import { readSequenceReach, sequenceReachKey, writeSequenceReach } from "../../../../recall/conditional-field/engine/sequence-reach.js";
import { ObservedRelations, relationPageJoinRows, retainRelationPage } from "../../../../recall/conditional-field/engine/observed-relations.js";
import { RetainedSequence } from "../../../../recall/conditional-field/engine/retained-sequence.js";
import {
  applyObserverPage,
  createConditionalField,
  withdrawDerivationLeaves,
  type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import { restoredFieldFootprint } from "../../../../recall/runtime/request-cost-engine-snapshot.js";
import { RequestCostLedger } from "../../../../recall/runtime/request-cost-ledger.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const OPEN_GUARD = { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } as const;
const AUTH_GUARD: Guard = { schema_version: 1, kind: "authorization", variable: "c",
  authorization_scope: "project", time_scope: "none", verdict: "unresolved" };

function relation(name: string, target = "y", guard: Guard = OPEN_GUARD): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: name, source_variable: "x", target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard };
}

function query(program: QueryProgram, patch: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return { schema_version: 1, query_id: "relation-row-increment", snapshot_id: SNAPSHOT_ID, status: "resolved",
    holes: [], hypotheses: [], program, view: defaultView(), ...patch };
}

function edge(predicate: string, source: string, target: string, id: string): AdjacencyRow & { resultObjectId: string } {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, resultObjectId: target, predicate,
    source_revision: "rev", validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
}

function facts(ids: readonly string[], scope?: Readonly<Record<string, string>>): Map<string, BoundSourceFacts> {
  return new Map(ids.map((object_id) => [object_id, {
    object_id, source_revision: "rev", ...(scope?.[object_id] === undefined ? {} : { scope_class: scope[object_id] })
  }]));
}

function seeded(program: QueryProgram, variants: readonly Readonly<{ hypothesis?: string; binding?: string }>[] = [{}]): FieldEngineState {
  const starts = seedProgramStates(program);
  return createConditionalField({
    interpretation: query(program),
    budget: defaultBudget({ work_units: 200_000, memory_bytes: 2_000_000, finalization_reserve: 0, min_envelope: 0 }),
    seeds: variants.flatMap((variant) => starts.map((programState) => ({
      schema_version: 1, milligrades: 1000,
      state: productKey("a", variant.hypothesis ?? "h0", variant.binding ?? "unbound", programState)
    })))
  });
}

function observerPage(state: FieldEngineState): ObserverPage {
  return { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}

function settle(
  state: FieldEngineState,
  rows: readonly AdjacencyRow[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  joinRows?: readonly AdjacencyRow[]
): FieldEngineState {
  return resumePathEffects({
    ...state,
    remaining_exploration: 200_000,
    remaining_memory_bytes: Math.max(state.remaining_memory_bytes, 1_000_000),
    memory_exhausted: false,
    retention_rejected: undefined,
    pending_path_effects: {
      offset: 0, retained_bytes: 0, page: observerPage(state),
      input: { rows, options: {
        interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts,
        liveStates: state.seen_identities, facets: state.facets, discoveries: state.discoveries,
        bindingContexts: state.binding_contexts,
        ...(joinRows === undefined ? {} : { joinRows })
      } }
    }
  });
}

function byPages(
  state: FieldEngineState,
  pages: readonly (readonly AdjacencyRow[])[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>
): FieldEngineState {
  let current = state;
  let population: AdjacencyRow[] = [];
  for (const page of pages) {
    const prior = population.length;
    population = population.concat(page);
    current = settle(current, population, sourceFacts, prior === 0 ? undefined : page);
    expect(current.pending_path_effects, page.map((row) => row.assertionId).join(",")).toBeUndefined();
  }
  return current;
}

function project(state: FieldEngineState) {
  const bindings = state.binding.kind !== "bound" ? state.binding.kind : state.binding.snapshot.values.map((value) => ({
    subject: productSubjectId(value.state), hypothesis: value.state.hypothesis_id, binding: value.state.binding_context,
    program: value.state.program_state, accepting: value.accepting === true, grade: value.milligrades ?? null
  })).sort(byJson);
  const transitions = state.transitions.map((row) => ({
    instance: row.instance_id ?? null, kind: row.relation_kind, grade: row.strength_milligrades,
    from: productSubjectId(row.from), fromHypothesis: row.from.hypothesis_id, fromBinding: row.from.binding_context,
    to: productSubjectId(row.to), toHypothesis: row.to.hypothesis_id, toBinding: row.to.binding_context
  })).sort(byJson);
  const derivations = state.derivations.map((row) => ({
    id: row.derivation_id, leaves: [...row.leaf_ids].sort(), grade: row.association_milligrades ?? null
  })).sort(byJson);
  const facets = state.facets.map((row) => ({
    path: row.path_id, coordinates: [...row.coordinates],
    obligations: [...row.obligations ?? []].map((item) => item.obligation_id).sort()
  })).sort(byJson);
  return { bindings, transitions, derivations, facets, guards: state.observation_gaps?.guards === true,
    pending: state.pending_path_effects !== undefined };
}

function byJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function counting(rows: readonly AdjacencyRow[], visits: { count: number }): Iterable<AdjacencyRow> {
  return { *[Symbol.iterator]() { for (const row of rows) { visits.count += 1; yield row; } } };
}

function hop(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD };
}

function sequenceHyperedge(steps: readonly QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "hyperedge", join: "and", premises: [
    { schema_version: 1, kind: "alternative", options: [{ schema_version: 1, kind: "sequence", steps }] }
  ] };
}

function hyperLeaves(effects: ReturnType<typeof adjacencyEffectsForRows>): Set<string>[] {
  return effects.filter((effect) => effect.hyperedge !== undefined).map((effect) =>
    new Set((effect.derivations ?? []).flatMap((row) => row.leaf_ids)));
}

function hyperSubjects(effects: ReturnType<typeof adjacencyEffectsForRows>): string[] {
  return effects.flatMap((effect) => effect.hyperedge === undefined ? [] : [productSubjectId(effect.hyperedge.to)]);
}

function storedFacts(ids: readonly string[]): PersistentStringMap<BoundSourceFacts> {
  let stored = new PersistentStringMap<BoundSourceFacts>();
  for (const object_id of ids) stored = stored.with(object_id, { object_id, source_revision: "rev" });
  return stored;
}

function drain<T>(steps: Generator<unknown, T>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

function resumeOnAutomaton(
  state: FieldEngineState,
  rows: readonly AdjacencyRow[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  joinRows?: readonly AdjacencyRow[]
): FieldEngineState {
  const automaton = state.compiled_automaton;
  return resumePathEffects({
    ...state,
    remaining_exploration: 200_000,
    memory_exhausted: false,
    retention_rejected: undefined,
    pending_path_effects: {
      offset: 0, retained_bytes: 0, page: observerPage(state),
      input: { rows, options: {
        interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts,
        liveStates: state.seen_identities, facets: state.facets, discoveries: state.discoveries,
        bindingContexts: state.binding_contexts,
        ...(automaton === undefined ? {} : { compiledAutomaton: automaton }),
        ...(joinRows === undefined ? {} : { joinRows })
      } }
    }
  });
}

function acceptingBindings(state: FieldEngineState): string[] {
  const projected = project(state);
  if (!Array.isArray(projected.bindings)) return [];
  return projected.bindings.flatMap((row) => row.accepting ? [`${row.subject}|${row.binding}`] : []);
}

function sequenceOwner(state: FieldEngineState, automaton: object): object {
  return state.sequence_reach_owner ?? automaton;
}

describe("incremental relation-row join", () => {
  it("admits changed assertions instead of a key-order length suffix", () => {
    const retained = retainRelationPage(new ObservedRelations().with(edge("p", "a", "b", "b")).with(edge("p", "a", "d", "d")),
      [edge("p", "a", "c", "c")]);
    expect(retained.changed.map((row) => row.assertionId)).toEqual(["c"]);
    expect(retained.population.at(retained.population.length - 1)?.assertionId).toBe("d");
    const same = retainRelationPage(retained.population, retained.changed);
    expect(same.changed).toEqual([]);
    expect(same.population).toBe(retained.population);
  });

  it("matches a from-scratch join for paged rows, distinct bindings, and distinct assertions", () => {
    const program = relation("p");
    const state = seeded(program, [{}, { hypothesis: "h-other", binding: "other-binding" }]);
    const oldRow = edge("p", "a", "b", "same-endpoints");
    const sameContent = edge("p", "a", "b", "same-endpoints-other-assertion");
    const late = edge("p", "a", "c", "late-row");
    const source = facts(["a", "b", "c"]);
    const paged = byPages(state, [[oldRow], [sameContent], [late]], source);
    const scratch = settle(state, [oldRow, sameContent, late], source);
    expect(project(paged)).toEqual(project(scratch));
    const instances = paged.transitions.map((row) => [row.instance_id, row.from.hypothesis_id, row.from.binding_context, productSubjectId(row.to)]);
    expect(instances).toEqual(expect.arrayContaining([
      ["same-endpoints", "h0", "unbound", "b"],
      ["same-endpoints", "h-other", "other-binding", "b"],
      ["same-endpoints-other-assertion", "h0", "unbound", "b"],
      ["same-endpoints-other-assertion", "h-other", "other-binding", "b"],
      ["late-row", "h0", "unbound", "c"],
      ["late-row", "h-other", "other-binding", "c"]
    ]));
  });

  it("keeps a late facet witness on an old row and a later row", () => {
    const program = relation("p");
    const state = seeded(program);
    const from = state.seen_identities.at(0)!;
    const oldRow = edge("p", "a", "b", "old-row");
    const late = edge("p", "a", "c", "late-row");
    const source = facts(["a", "b", "c"]);
    const facet = { schema_version: 1 as const, path_id: composedFacetPathId(from, "late-facet"),
      obligations: [{ obligation_id: "late-obligation", domain_id: "association" }], coordinates: [321] };
    const withFacet = applyObserverPage(state, { page: observerPage(state), effects: [{ observation_id: "late-facet", facet }] });
    const scratch = settle(withFacet, [oldRow, late], source);
    const refreshed = settle(settle(withFacet, [oldRow], source), [oldRow, late], source, [late]);
    expect(project(refreshed)).toEqual(project(scratch));
    const witnessed = refreshed.facets.filter((row) => row.coordinates.includes(321));
    expect(witnessed.length).toBeGreaterThan(0);
    expect(witnessed).toEqual(scratch.facets.filter((row) => row.coordinates.includes(321)));
  });

  it("merges a row delta with a prior unknown and clears it only on a later complete pass", () => {
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [relation("p", "y", AUTH_GUARD), relation("q")] };
    const state = seeded(program, [{ binding: "c=x" }]);
    const guarded = edge("p", "a", "b", "guarded-row");
    const plain = edge("q", "a", "c", "plain-row");
    const unknownFacts = facts(["a", "b", "c"]);
    const paged = byPages(state, [[guarded], [plain]], unknownFacts);
    const scratch = settle(state, [guarded, plain], unknownFacts);
    expect(project(paged)).toEqual(project(scratch));
    expect(paged.observation_gaps?.guards).toBe(true);
    expect(project(paged).bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "c", accepting: true })
    ]));
    expect(project(paged).bindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "b", accepting: true })
    ]));
    const unrelated = facts(["a", "b", "c", "other"]);
    const unrelatedPass = settle(paged, [guarded, plain], unrelated);
    expect(project(unrelatedPass)).toEqual(project(settle(state, [guarded, plain], unrelated)));
    expect(unrelatedPass.observation_gaps?.guards).toBe(true);
    const known = facts(["a", "b", "c", "x"], { x: "project" });
    const resolved = settle(paged, [guarded, plain], known);
    expect(project(resolved)).toEqual(project(settle(state, [guarded, plain], known)));
    expect(resolved.observation_gaps?.guards).toBe(false);
    expect(project(resolved).bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "b", accepting: true }),
      expect.objectContaining({ subject: "c", accepting: true })
    ]));
  });

  it("resumes an interrupted row delta and replays a refused effect admission", () => {
    const program = relation("p");
    const state = seeded(program);
    const oldRow = edge("p", "a", "b", "old-row");
    const late = edge("p", "a", "c", "late-row");
    const source = facts(["a", "b", "c"]);
    const first = settle(state, [oldRow], source);
    const scratch = settle(state, [oldRow, late], source);
    let interrupted = resumePathEffects({
      ...first, remaining_exploration: 1, remaining_memory_bytes: 1_000_000, memory_exhausted: false,
      pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(first),
        input: { rows: [oldRow, late], options: {
          interpretation: first.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [late],
          liveStates: first.seen_identities, facets: first.facets, discoveries: first.discoveries,
          bindingContexts: first.binding_contexts
        } } }
    });
    expect(interrupted.pending_path_effects).toBeDefined();
    expect(interrupted.observation_gaps?.guards).toBe(first.observation_gaps?.guards);
    interrupted = resumePathEffects({ ...interrupted, remaining_exploration: 200_000, memory_exhausted: false, retention_rejected: undefined });
    expect(project(interrupted)).toEqual(project(scratch));

    let refused: FieldEngineState | undefined;
    for (let memory = 8_500; memory < 80_000; memory += 250) {
      const candidate = resumePathEffects({
        ...first, remaining_exploration: 20_000, remaining_memory_bytes: memory, memory_exhausted: false, retention_rejected: undefined,
        pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(first),
          input: { rows: [oldRow, late], options: {
            interpretation: first.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [late],
            liveStates: first.seen_identities, facets: first.facets, discoveries: first.discoveries,
            bindingContexts: first.binding_contexts
          } } }
      });
      if (candidate.retention_rejected !== undefined && candidate.pending_path_effects !== undefined) { refused = candidate; break; }
    }
    expect(refused?.pending_path_effects?.input.options.joinRows?.map((row) => row.assertionId)).toEqual(["late-row"]);
    const replayed = resumePathEffects({ ...refused!, remaining_exploration: 200_000, remaining_memory_bytes: 1_000_000,
      memory_exhausted: false, retention_rejected: undefined });
    expect(project(replayed)).toEqual(project(scratch));
  });

  it("keeps independent support when a needed leaf is withdrawn", () => {
    const program = relation("p");
    const state = seeded(program);
    const first = edge("p", "a", "b", "leaf-a");
    const second = edge("p", "a", "b", "leaf-b");
    const source = facts(["a", "b"]);
    const paged = byPages(state, [[first], [second]], source);
    const scratch = settle(state, [first, second], source);
    expect(project(paged)).toEqual(project(scratch));
    for (const removed of ["leaf-a", "leaf-b"]) {
      const kept = removed === "leaf-a" ? "leaf-b" : "leaf-a";
      expect(project(withdrawDerivationLeaves(paged, removed))).toEqual(project(withdrawDerivationLeaves(scratch, removed)));
      expect(withdrawDerivationLeaves(paged, removed).transitions.map((row) => row.instance_id)).toEqual([kept]);
      expect(withdrawDerivationLeaves(withdrawDerivationLeaves(paged, removed), kept).transitions).toHaveLength(0);
    }
  });

  it("completes a hyperedge from a new premise plus a retained premise", () => {
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [relation("p", "y"), relation("q", "z")] };
    const state = seeded(program);
    const premise = edge("p", "a", "b", "premise-p");
    const added = edge("q", "a", "c", "premise-q");
    const source = facts(["a", "b", "c"]);
    const paged = byPages(state, [[premise], [added]], source);
    const scratch = settle(state, [premise, added], source);
    expect(project(paged)).toEqual(project(scratch));
    expect(paged.transitions.some((row) => row.relation_kind === "hyperedge" || row.instance_id === undefined)).toBe(true);
    expect(paged.facets.length).toBe(scratch.facets.length);
  });

  it("preserves a same_path joint witness across a later hop", () => {
    const program: QueryProgram = { schema_version: 1, kind: "repeat", count: 2, local_variables: ["x", "y"], body: relation("p") };
    const state = seeded(program);
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("p", "b", "c", "hop-2");
    const source = facts(["a", "b", "c"]);
    const paged = byPages(state, [[first], [second]], source);
    const scratch = settle(state, [first, second], source);
    expect(project(paged)).toEqual(project(scratch));
    expect(paged.facets.some((row) => row.coordinates.length >= 2)).toBe(true);
  });

  it("joins a new sequence hop with the retained hop inside an alternative premise", () => {
    const step = (kind: string, source: string, target: string): QueryProgram => ({
      schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
      facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD
    });
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [step("p", "x", "m"), step("q", "m", "y")] };
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [
      { schema_version: 1, kind: "alternative", options: [sequence] }
    ] };
    const state = seeded(program);
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("q", "b", "c", "hop-2");
    const source = facts(["a", "b", "c"]);
    const paged = byPages(state, [[first], [second]], source);
    const scratch = settle(state, [first, second], source);
    expect(paged.observation_gaps?.guards).toBe(false);
    expect(project(paged)).toEqual(project(scratch));
    expect(scratch.transitions.length).toBeGreaterThan(0);
    const directInput = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source,
      liveStates: state.seen_identities };
    adjacencyEffectsForRows([first], directInput);
    const visits = { count: 0 };
    const direct = adjacencyEffectsForRows(counting([first, second], visits), { ...directInput, joinRows: [second] });
    expect(visits.count).toBe(0);
    const covered = direct.filter((effect) => effect.hyperedge !== undefined).map((effect) =>
      new Set((effect.derivations ?? []).flatMap((row) => row.leaf_ids)));
    expect(covered.some((ids) => ids.has("hop-1") && ids.has("hop-2"))).toBe(true);
  });

  it("rechecks only a sequence hop whose target revision arrives on a later state", () => {
    const step = (kind: string, source: string, target: string): QueryProgram => ({
      schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
      facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD
    });
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [step("p", "x", "y")] };
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [
      { schema_version: 1, kind: "alternative", options: [sequence] }
    ] };
    const state = seeded(program);
    const from = state.seen_identities.at(0)!;
    const oldRow = edge("p", "a", "t", "old-row");
    const noise = edge("p", "z", "c", "noise-row");
    const source = facts(["a"]);
    const base = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities };
    const first = adjacencyEffectsForRows([oldRow], base);
    expect(first.some((effect) => effect.missing_target_revision === true)).toBe(true);
    expect(first.some((effect) => effect.hyperedge !== undefined)).toBe(false);
    const witness = productKey("t", from.hypothesis_id, from.binding_context, from.program_state);
    const visits = { count: 0 };
    const promoted = adjacencyEffectsForRows(counting([oldRow, noise], visits), {
      ...base, liveStates: RetainedSequence.from([...state.seen_identities, witness]), joinRows: [noise]
    });
    expect(visits.count).toBe(0);
    const leaves = promoted.filter((effect) => effect.hyperedge !== undefined).flatMap((effect) =>
      (effect.derivations ?? []).flatMap((row) => row.leaf_ids));
    expect(leaves).toContain("old-row");
  });

  it("keeps two hyperedges when compiled paths share an endpoint under different bindings", () => {
    const step = (kind: string, source: string, target: string): QueryProgram => ({
      schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
      facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD
    });
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [step("p", "x", "y"), step("q", "y", "z")] };
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [sequence] };
    const state = seeded(program);
    const rows = [edge("p", "a", "m1", "left-p"), edge("q", "m1", "b", "left-q"), edge("p", "a", "m2", "right-p"), edge("q", "m2", "b", "right-q")];
    const hyperedges = adjacencyEffectsForRows(rows, {
      interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: facts(["a", "m1", "m2", "b"]),
      liveStates: state.seen_identities
    }).flatMap((effect) => effect.hyperedge === undefined ? [] : [effect.hyperedge]);
    expect(hyperedges).toHaveLength(2);
    expect(new Set(hyperedges.map((row) => row.to.binding_context)).size).toBe(2);
    expect(new Set(hyperedges.map((row) => productSubjectId(row.to)))).toEqual(new Set(["b"]));
  });

  it("does not revisit retained rows while a new-state suffix still reads them", () => {
    const program = relation("p");
    const state = seeded(program);
    const programState = state.seen_identities.at(0)!.program_state;
    const oldRows = Array.from({ length: 12 }, (_, index) => edge("p", "a", `t-${index}`, `old-${index}`));
    const late = edge("p", "a", "late", "late-row");
    const population = [...oldRows, late];
    const source = facts(["a", "late", ...oldRows.map((row) => row.targetObjectId)]);
    const options = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities };
    const retained = { count: 0 };
    adjacencyEffectsForRows(counting(population, retained), { ...options, joinRows: [late] });
    expect(retained.count).toBe(0);
    const suffix = { count: 0 };
    const liveStates = [state.seen_identities.at(0)!, productKey("b", "h0", "unbound", programState)];
    adjacencyEffectsForRows(counting(population, suffix), { ...options, liveStates, liveStateOffset: 1 });
    expect(suffix.count).toBeGreaterThanOrEqual(population.length);
    const full = createAdjacencyEffectCursor(population, options);
    const delta = createAdjacencyEffectCursor(population, { ...options, joinRows: [late] });
    expect(delta.initialRetainedBytes - full.initialRetainedBytes).toBe(64 + 8);
    const fullAdvance = full.advance(0, 1_000_000, 2_000_000);
    const deltaAdvance = delta.advance(0, 1_000_000, 2_000_000);
    expect(deltaAdvance.work).toBeLessThan(fullAdvance.work / 5);
    expect(deltaAdvance.effects.flatMap((effect) => effect.transition === undefined ? [] : [effect.transition.instance_id])).toEqual(["late-row"]);
    const hyperedge: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [relation("p", "y"), relation("q", "z")] };
    const hyperState = seeded(hyperedge);
    const oldP = edge("p", "a", "b", "old-p");
    const oldQ = edge("q", "a", "c", "old-q");
    const newQ = edge("q", "a", "d", "new-q");
    const hyperPopulation = [oldP, oldQ, newQ];
    const hyperOptions = { interpretation: hyperState.interpretation, asOf: AS_OF, overlay: {},
      liveStates: hyperState.seen_identities, sourceFacts: facts(["a", "b", "c", "d"]) };
    const hyperLeaves = (rows: Iterable<AdjacencyRow>, joinRows?: readonly AdjacencyRow[]) => adjacencyEffectsForRows(rows, {
      ...hyperOptions, ...(joinRows === undefined ? {} : { joinRows })
    }).flatMap((effect) => effect.hyperedge === undefined ? [] : [[...(effect.derivations ?? []).flatMap((row) => row.leaf_ids)].sort()]);
    const hyperVisits = { count: 0 };
    const fullLeaves = hyperLeaves(hyperPopulation);
    const deltaLeaves = hyperLeaves(counting(hyperPopulation, hyperVisits), [newQ]);
    expect(hyperVisits.count).toBeGreaterThan(0);
    expect(fullLeaves).toEqual(expect.arrayContaining([["old-p", "old-q"], ["new-q", "old-p"]]));
    expect(deltaLeaves.every((ids) => ids.includes("new-q"))).toBe(true);
    expect(deltaLeaves).toEqual(fullLeaves.filter((ids) => ids.includes("new-q")));
  });

  it("promotes an old row when a later state supplies the missing target revision", () => {
    const program = relation("p");
    const state = seeded(program);
    const from = state.seen_identities.at(0)!;
    const filler = productKey("filler", from.hypothesis_id, from.binding_context, from.program_state);
    const witness = productKey("t", from.hypothesis_id, from.binding_context, from.program_state);
    const oldRow = edge("p", "a", "t", "old-row");
    const source = facts(["a"]);
    const liveStates = [from, filler, witness];
    const input = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates };
    const oldTransitions = (effects: ReturnType<typeof adjacencyEffectsForRows>) => effects.filter((effect) => effect.transition?.instance_id === "old-row");
    expect(oldTransitions(adjacencyEffectsForRows([oldRow], { ...input, liveStateOffset: 2 }))).toHaveLength(0);
    expect(oldTransitions(adjacencyEffectsForRows([oldRow], input))).toHaveLength(1);
    expect(observedTargetRevision("t", source, liveStates)).toBe("rev");
    const missed = resumePathEffects({
      ...state, remaining_exploration: 200_000, remaining_memory_bytes: 5_000_000, memory_exhausted: false,
      pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(state),
        input: { rows: [oldRow], options: {
          interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source,
          liveStates: state.seen_identities, facets: state.facets, discoveries: state.discoveries,
          bindingContexts: state.binding_contexts
        } } }
    });
    expect(missed.transitions.some((row) => row.instance_id === "old-row")).toBe(false);
    expect(missed.observation_gaps?.guards).toBe(true);
    expect(missed.pending_path_effects?.input.options.liveStateOffset).toBe(0);
    expect(missed.pending_path_effects?.input.options.joinRows).toBeUndefined();
    const noise = edge("p", "z", "c", "noise-row");
    const identities = RetainedSequence.from([...missed.seen_identities, filler, witness]);
    const promoted = resumePathEffects({
      ...missed, seen_identities: identities, remaining_exploration: 200_000, remaining_memory_bytes: 5_000_000,
      memory_exhausted: false, retention_rejected: undefined,
      pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(missed),
        input: { rows: [oldRow, noise], options: {
          interpretation: missed.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [noise],
          liveStates: identities, facets: missed.facets, discoveries: missed.discoveries,
          bindingContexts: missed.binding_contexts
        } } }
    });
    expect(oldTransitions(adjacencyEffectsForRows([oldRow, noise], {
      interpretation: missed.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: identities, joinRows: [noise]
    }))).toHaveLength(0);
    expect(promoted.transitions.some((row) => row.instance_id === "old-row")).toBe(true);
  });

  it("keeps two products and two facet paths for the same endpoint under different bindings", () => {
    const state = seeded(relation("p"), [{}, { hypothesis: "h-other", binding: "other-binding" }]);
    const joined = settle(state, [edge("p", "a", "b", "shared-endpoint")], facts(["a", "b"]));
    if (joined.binding.kind !== "bound") throw new Error("expected a bound field");
    const products = joined.binding.snapshot.values.filter((value) => value.accepting && productSubjectId(value.state) === "b");
    expect(new Set(products.map((value) => productStateNodeId(value.state))).size).toBe(2);
    const pathIds = new Set(joined.facets.flatMap((facet) => products.some((value) => facetBelongsToOutput(facet.path_id, value.state)) ? [facet.path_id] : []));
    expect(pathIds.size).toBe(2);
    expect(joined.transitions.filter((row) => row.instance_id === "shared-endpoint")).toHaveLength(2);
  });

  it("keeps same_path false for crossed coordinates at threshold 500 after extension", () => {
    const from = productKey("a");
    const left = { schema_version: 1 as const, path_id: composedFacetPathId(from, "left"),
      obligations: [{ obligation_id: "left-axis", domain_id: "association" }, { obligation_id: "right-axis", domain_id: "association" }],
      coordinates: [900, 100] };
    const right = { schema_version: 1 as const, path_id: composedFacetPathId(from, "right"),
      obligations: [{ obligation_id: "left-axis", domain_id: "association" }, { obligation_id: "far-axis", domain_id: "association" }],
      coordinates: [100, 900] };
    expect(samePathAccepts([left, right], 500)).toBe(false);
    const extended = drain(extendFacets(new PathFacetLookup(RetainedSequence.from([left, right])), from, productKey("b"), "later-hop", 1000));
    expect(extended).toHaveLength(2);
    expect(extended.map((vector) => vector.coordinates)).toEqual([[900, 100, 1000], [100, 900, 1000]]);
    expect(samePathAccepts(extended, 500)).toBe(false);
  });

  it("does not publish a new source-fact snapshot from a row delta", () => {
    const oldRow = edge("p", "a", "b", "old-row");
    const late = edge("p", "a", "c", "late-row");
    const oldFacts = storedFacts(["a", "b"]);
    const newFacts = storedFacts(["a", "b", "c"]);
    const joined = settle(settle({ ...seeded(relation("p")), source_facts: oldFacts }, [oldRow], oldFacts), [oldRow], oldFacts);
    expect(joined.path_effect_frontier?.sourceFacts).toBe(oldFacts);
    const delta = settle({ ...joined, source_facts: newFacts }, [oldRow, late], newFacts, [late]);
    expect(delta.path_effect_frontier?.sourceFacts).not.toBe(newFacts);
    const published = settle(delta, [oldRow, late], newFacts);
    expect(published.path_effect_frontier?.sourceFacts).toBe(newFacts);
  });

  it("keeps one final row when a page repeats an assertion id", () => {
    const first = edge("p", "a", "b", "same");
    const revised = { ...edge("p", "a", "c", "same"), validity: { kind: "open" as const, valid_from: "2026-06-01T00:00:00.000Z" } };
    const retained = retainRelationPage(new ObservedRelations().with(edge("p", "a", "kept", "kept")), [first, revised]);
    expect(retained.changed.map((row) => row.assertionId)).toEqual(["same"]);
    expect(retained.changed[0]).toBe(retained.population.get("same"));
    expect(retained.changed[0]?.targetObjectId).toBe("c");
    expect(relationPageJoinRows(retained.population, retained.changed, false)?.map((row) => row.assertionId)).toEqual(["same"]);
    expect(relationPageJoinRows(retained.population, retained.changed, true)).toBeUndefined();
    const covered = retainRelationPage(new ObservedRelations(), [first, revised]);
    expect(covered.changed).toHaveLength(1);
    expect(relationPageJoinRows(covered.population, covered.changed, false)).toBeUndefined();
  });

  it("shares sequence reach across structurally equal programs", () => {
    const owner = {};
    const reach = { states: [], transitions: [], derivations: [], roots: {}, unresolved: [] };
    writeSequenceReach(owner, sequenceReachKey(relation("p"), "seed"), reach);
    expect(readSequenceReach(owner, sequenceReachKey(relation("p"), "seed"))).toBe(reach);
  });

  it("keeps a warm sequence frontier across a replaced interpretation", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const state = seeded(program);
    const automaton = compileProgramAutomaton(program);
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("q", "b", "c", "hop-2");
    const source = facts(["a", "b", "c"]);
    const base = { asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities, compiledAutomaton: automaton };
    adjacencyEffectsForRows([first], { ...base, interpretation: state.interpretation });
    const visits = { count: 0 };
    const joined = adjacencyEffectsForRows(counting([first, second], visits), {
      ...base, interpretation: query(structuredClone(program)), joinRows: [second]
    });
    expect(visits.count).toBe(0);
    expect(hyperLeaves(joined).some((ids) => ids.has("hop-1") && ids.has("hop-2"))).toBe(true);
  });

  it("reads retained sequence hops when the frontier is missing", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const state = seeded(program);
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("q", "b", "c", "hop-2");
    const visits = { count: 0 };
    const joined = adjacencyEffectsForRows(counting([first, second], visits), {
      interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: facts(["a", "b", "c"]),
      liveStates: state.seen_identities, joinRows: [second]
    });
    expect(visits.count).toBeGreaterThan(0);
    expect(hyperLeaves(joined).some((ids) => ids.has("hop-1") && ids.has("hop-2"))).toBe(true);
  });

  it("replaces a stored sequence hop when that assertion id changes", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const state = seeded(program);
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("q", "b", "c", "hop-2");
    const source = facts(["a", "b", "c", "d"]);
    const base = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities };
    adjacencyEffectsForRows([first, second], base);
    const visits = { count: 0 };
    const revised = adjacencyEffectsForRows(counting([first, edge("q", "b", "d", "hop-2")], visits), { ...base, joinRows: [edge("q", "b", "d", "hop-2")] });
    expect(visits.count).toBe(0);
    expect(hyperSubjects(revised)).toContain("d");
    expect(hyperSubjects(revised)).not.toContain("c");
    const retractedState = seeded(program);
    const retractedBase = { ...base, interpretation: retractedState.interpretation, liveStates: retractedState.seen_identities };
    adjacencyEffectsForRows([first, second], retractedBase);
    const retracted = adjacencyEffectsForRows([first, { ...second, resolutionKind: "retracted" }], {
      ...retractedBase, joinRows: [{ ...second, resolutionKind: "retracted" }]
    });
    expect(hyperSubjects(retracted)).not.toContain("c");
    expect(hyperLeaves(retracted).some((ids) => ids.has("hop-2"))).toBe(false);
  });

  it("does not emit a revised hyperedge sequence hop when the other premise is the delta", () => {
    const inner: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [hop("p", "x", "y")] };
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [inner] };
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [sequence, hop("q", "x", "z")] };
    const state = seeded(program);
    const stored = edge("p", "a", "old-target", "inner-p");
    const sibling = edge("q", "a", "c", "outer-q");
    const source = facts(["a", "old-target", "c", "new-target"]);
    const base = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities };
    expect(hyperSubjects(adjacencyEffectsForRows([stored, sibling], base))).toContain("old-target");
    const revised = edge("p", "a", "new-target", "inner-p");
    const next = adjacencyEffectsForRows([revised, sibling], { ...base, joinRows: [revised, sibling] });
    expect(hyperSubjects(next)).toContain("new-target");
    expect(hyperSubjects(next)).not.toContain("old-target");
  });

  it("does not replay a withdrawn sequence hop on the next row delta", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const automaton = compileProgramAutomaton(program);
    const state = { ...seeded(program), compiled_automaton: automaton };
    const first = edge("p", "a", "b", "hop-1");
    const second = edge("q", "b", "c", "hop-2");
    const base = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: facts(["a", "b", "c"]),
      liveStates: state.seen_identities, compiledAutomaton: automaton };
    adjacencyEffectsForRows([first, second], base);
    const withdrawn = withdrawDerivationLeaves(state, "hop-1");
    const noise = edge("q", "z", "w", "noise-row");
    const visits = { count: 0 };
    const after = adjacencyEffectsForRows(counting([first, second, noise], visits), {
      ...base,
      ...(withdrawn.sequence_reach_owner === undefined ? {} : { sequenceReachOwner: withdrawn.sequence_reach_owner }),
      joinRows: [noise]
    });
    expect(visits.count).toBe(0);
    expect(hyperLeaves(after).some((ids) => ids.has("hop-1"))).toBe(false);
  });

  it("grounds a promoted sequence hop on the binding that still carries locals", () => {
    const repeat: QueryProgram = { schema_version: 1, kind: "repeat", count: 2, local_variables: ["x", "y"], body: relation("p") };
    const program: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [
      { schema_version: 1, kind: "alternative", options: [repeat] }
    ] };
    const state = seeded(program);
    const from = state.seen_identities.at(0)!;
    const bound = edge("p", "a", "b", "bound-hop");
    const open = edge("p", "b", "t", "open-hop");
    const source = facts(["a", "b"]);
    const base = { interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, liveStates: state.seen_identities };
    const missed = adjacencyEffectsForRows([bound, open], base);
    expect(missed.some((effect) => effect.missing_target_revision === true)).toBe(true);
    expect(missed.some((effect) => effect.hyperedge !== undefined)).toBe(false);
    const witness = productKey("t", from.hypothesis_id, from.binding_context, from.program_state);
    const noise = edge("p", "z", "c", "noise-row");
    const visits = { count: 0 };
    const promoted = adjacencyEffectsForRows(counting([bound, open, noise], visits), {
      ...base, liveStates: RetainedSequence.from([...state.seen_identities, witness]), joinRows: [noise]
    });
    expect(visits.count).toBe(0);
    expect(hyperLeaves(promoted).some((ids) => ids.has("bound-hop") && ids.has("open-hop"))).toBe(true);
  });

  it("keeps a prior unknown guard when exploration runs out before the row-delta recheck", () => {
    const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [relation("p", "y", AUTH_GUARD), relation("q")] };
    const state = seeded(program, [{ binding: "c=x" }]);
    const guarded = edge("p", "a", "b", "guarded-row");
    const source = facts(["a", "b"]);
    const established = settle(state, [guarded], source);
    expect(established.observation_gaps?.guards).toBe(true);
    expect(established.pending_path_effects).toBeUndefined();
    const noise = edge("q", "z", "w", "noise-row");
    const population = [guarded, noise];
    let stopped: FieldEngineState | undefined;
    for (let work = 1; work <= 64; work += 1) {
      const candidate = resumePathEffects({
        ...established, remaining_exploration: work, remaining_memory_bytes: 1_000_000,
        memory_exhausted: false, retention_rejected: undefined,
        pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(established),
          input: { rows: population, options: {
            interpretation: established.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [noise],
            liveStates: established.seen_identities, facets: established.facets, discoveries: established.discoveries,
            bindingContexts: established.binding_contexts
          } } }
      });
      const pending = candidate.pending_path_effects;
      // A later full pass recomputes the guard. This budget can publish before that pass.
      if (pending !== undefined && pending.input.options.joinRows === undefined && pending.population_checked !== true
        && candidate.remaining_exploration === 0) { stopped = candidate; break; }
    }
    expect(stopped?.last_observer_status).toBe("interrupted");
    expect(stopped?.pending_path_effects?.input.options.liveStateOffset).toBe(0);
    expect(stopped?.seen_identities.length).toBe(established.seen_identities.length);
    expect(stopped?.observation_gaps?.guards).toBe(true);
  });

  it("keeps an independently supported sequence hop when one or-child is withdrawn", () => {
    const inner: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [hop("p", "x", "m")] };
    const steps = [inner, hop("r", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = { ...seeded(program), compiled_automaton: automaton };
    const p1 = edge("p", "a", "m", "p1");
    const p2 = edge("p", "a", "m", "p2");
    const r1 = edge("r", "m", "y", "r1");
    const source = facts(["a", "m", "y"]);
    const warmed = resumeOnAutomaton(state, [p1, p2], source);
    const from = state.seen_identities.at(0)!;
    const withdrawn = withdrawDerivationLeaves(warmed, "p1");
    const surviving = readSequenceReach(sequenceOwner(withdrawn, automaton), sequenceReachKey(sequence, productStateNodeId(from)));
    const incremental = resumeOnAutomaton(withdrawn, [p2, r1], source, [r1]);
    const fresh = resumeOnAutomaton({ ...seeded(program), compiled_automaton: compileProgramAutomaton(program) }, [p2, r1], source);
    expect({
      pending: incremental.pending_path_effects !== undefined,
      gaps: incremental.observation_gaps,
      keptHop: (surviving?.transitions.length ?? 0) > 0,
      keptP2: surviving?.derivations.some((row) => row.leaf_ids.includes("p2")) === true,
      droppedP1: surviving?.derivations.some((row) => row.leaf_ids.includes("p1")) === true,
      accepted: acceptingBindings(incremental),
      fresh: acceptingBindings(fresh)
    }).toEqual({
      pending: false,
      gaps: { guards: false, measurements: false },
      keptHop: true,
      keptP2: true,
      droppedP1: false,
      accepted: ["y|m=m;x=a;y=y"],
      fresh: ["y|m=m;x=a;y=y"]
    });
  });

  it("charges the surviving sequence cache on the restored field footprint", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = { ...seeded(program), compiled_automaton: automaton };
    const warmed = resumeOnAutomaton(state, [edge("p", "a", "m", "only-p")], facts(["a", "m", "y"]));
    const from = state.seen_identities.at(0)!;
    const reach = readSequenceReach(sequenceOwner(warmed, automaton), sequenceReachKey(sequence, productStateNodeId(from)));
    const cacheBytes = 64 + Buffer.byteLength(JSON.stringify(reach), "utf8");
    const charged = warmed.sequence_reach_bytes ?? 0;
    const counted = restoredFieldFootprint(warmed) - restoredFieldFootprint({ ...warmed, sequence_reach_bytes: 0 });
    const remainingDrop = state.remaining_memory_bytes - warmed.remaining_memory_bytes;
    expect(warmed.pending_path_effects).toBeUndefined();
    expect(warmed.transitions).toHaveLength(0);
    expect(reach?.states.length).toBeGreaterThan(0);
    expect(reach?.transitions.length).toBeGreaterThan(0);
    expect(reach?.derivations.length).toBeGreaterThan(0);
    expect({ charged, counted, cacheBytes, remainingDrop }).toEqual({
      charged: cacheBytes, counted: cacheBytes, cacheBytes, remainingDrop: cacheBytes
    });
  });
});

describe("observed relation pages", () => {
  const program: QueryProgram = { schema_version: 1, kind: "alternative", options: [relation("p", "y", AUTH_GUARD), relation("q")] };

  function run(rows: readonly ReturnType<typeof edge>[], options: Readonly<{
    lexicalIds?: readonly string[];
    unavailable?: ReadonlySet<string>;
    scopes?: Readonly<Record<string, string>>;
    resume?: FieldEngineState;
    cost?: RequestCostLedger;
    work?: number;
    memory?: number;
  }> = {}) {
    const readers: ObserverReaders = {
      lexical: () => ({ ids: options.lexicalIds ?? ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => options.unavailable?.has(objectId) === true
        ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: true }
        : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: options.scopes?.[objectId] ?? "project" },
          rowsRead: 1, bytesRead: 32, unavailable: false },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit));
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const state = observeField(query(program, { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] }), {
      workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers, authorized_scopes: null,
      ...(options.resume === undefined ? {} : { resume_field: options.resume }),
      ...(options.cost === undefined ? {} : { cost: options.cost }),
      budget: defaultBudget({ work_units: options.work ?? 200_000, memory_bytes: options.memory ?? 2_000_000, finalization_reserve: 0, min_envelope: 0 })
    });
    const accepted = state.binding.kind === "bound" ? state.binding.snapshot.values
      .filter((value) => value.accepting && (value.milligrades ?? 0) > 0).map((value) => productSubjectId(value.state)).sort() : [];
    return { state, accepted };
  }

  it("keeps an unknown from an earlier page when later pages arrive", () => {
    const guarded = edge("p", "a", "b", "p-row");
    const plain = Array.from({ length: 20 }, (_, index) => edge("q", "a", `q-${String(index).padStart(2, "0")}`, `q-${String(index).padStart(2, "0")}`));
    const cost = new RequestCostLedger();
    const observed = run([guarded, ...plain], { unavailable: new Set(["x"]), cost });
    expect(observed.state.observation_gaps?.guards).toBe(true);
    expect(observed.accepted).toEqual(plain.map((row) => row.targetObjectId));
    expect(cost.snapshot().phases.adjacency.joins).toBeGreaterThan(0);
    const reopened = { ...observed.state,
      residuals: observed.state.residuals.map((region) => region.kind === "seed" ? { ...region, status: "open" as const } : region),
      resume_cursors: { ...observed.state.resume_cursors, seed: null } };
    const known = run([guarded, ...plain], { resume: reopened, lexicalIds: ["x"], scopes: { x: "project" }, memory: 20_000_000 });
    expect(known.state.observation_gaps?.guards).toBe(false);
    expect(known.accepted).toEqual(["b", ...plain.map((row) => row.targetObjectId)].sort());
    const unrelated = run([guarded, ...plain], { unavailable: new Set(["x"]), resume: reopened, lexicalIds: ["other"], memory: 20_000_000 });
    expect(unrelated.state.source_facts?.has("other")).toBe(true);
    expect(unrelated.state.observation_gaps?.guards).toBe(true);
    expect(unrelated.accepted).toEqual(observed.accepted);
  });

  it("rechecks an old row when a later page learns its endpoint fact", () => {
    const early = edge("p", "a", "b", "p-00");
    const fillers = Array.from({ length: 15 }, (_, index) => edge("p", "a", `t-${String(index).padStart(2, "0")}`, `p-${String(index + 1).padStart(2, "0")}`));
    const later = edge("p", "a", "x", "p-16");
    let release = false;
    const readers: ObserverReaders = {
      lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
      source: ({ objectId }) => objectId === "x" && !release
        ? { row: null, rowsRead: 0, bytesRead: 0, unavailable: true }
        : { row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
          rowsRead: 1, bytesRead: 32, unavailable: false },
      relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
        const pool = release ? [early, ...fillers, later] : [early, ...fillers];
        const remaining = pool.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
          && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
        const observations = remaining.slice(0, Math.min(limit, nativeLimit));
        const hidden = !release && subject === "a" && predicate === "p";
        return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
          bytesRead: observations.length, truncated: hidden || observations.length < remaining.length,
          committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
      }
    };
    const interpretation = query(program, { hypotheses: [{ schema_version: 1, hypothesis_id: "h",
      bindings: [{ schema_version: 1, variable: "c", value: "x" }] }] });
    const request = { workspace_id: "workspace-1", query_text: "a", as_of: AS_OF, readers, authorized_scopes: null,
      budget: defaultBudget({ work_units: 200_000, memory_bytes: 20_000_000, finalization_reserve: 0, min_envelope: 0 }) };
    const held = observeField(interpretation, request);
    expect(held.transitions.some((row) => row.instance_id === "p-00")).toBe(false);
    expect(held.observation_gaps?.guards).toBe(true);
    release = true;
    const learned = observeField(interpretation, { ...request, resume_field: held });
    expect(learned.transitions.some((row) => row.instance_id === "p-00")).toBe(true);
    expect(learned.observation_gaps?.guards).toBe(false);
  });
});
