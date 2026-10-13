import { describe, expect, it } from "vitest";
import {
  productSubjectId,
  type ObserverPage,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import { createAdjacencyEffectCursor, type AdjacencyRow } from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import {
  createConditionalField,
  withdrawDerivationLeaves,
  type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import {
  readSequenceReach,
  sequenceReachAccountBytes,
  sequenceReachKey,
  writeSequenceReach
} from "../../../../recall/conditional-field/engine/sequence-reach.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import { restoredFieldFootprint } from "../../../../recall/runtime/request-cost-engine-snapshot.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const OPEN_GUARD = { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } as const;

function hop(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD };
}

function sequenceHyperedge(steps: readonly QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "hyperedge", join: "and", premises: [
    { schema_version: 1, kind: "alternative", options: [{ schema_version: 1, kind: "sequence", steps }] }
  ] };
}

function query(program: QueryProgram): QueryInterpretation {
  return { schema_version: 1, query_id: "sequence-reach-lifecycle", snapshot_id: SNAPSHOT_ID, status: "resolved",
    holes: [], hypotheses: [], program, view: defaultView() };
}

function edge(predicate: string, source: string, target: string, id: string): AdjacencyRow & { resultObjectId: string } {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, resultObjectId: target, predicate,
    source_revision: "rev", validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
}

function facts(ids: readonly string[]): Map<string, BoundSourceFacts> {
  return new Map(ids.map((object_id) => [object_id, { object_id, source_revision: "rev" }]));
}

function seeded(program: QueryProgram): FieldEngineState {
  const starts = seedProgramStates(program);
  return createConditionalField({
    interpretation: query(program),
    budget: defaultBudget({ work_units: 200_000, memory_bytes: 2_000_000, finalization_reserve: 0, min_envelope: 0 }),
    seeds: starts.map((programState) => ({
      schema_version: 1, milligrades: 1000, state: productKey("a", "h0", "unbound", programState)
    }))
  });
}

function observerPage(state: FieldEngineState): ObserverPage {
  return { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}

function sequenceOwner(state: FieldEngineState, automaton: object): object {
  return state.sequence_reach_owner ?? automaton;
}

function withAutomaton(program: QueryProgram, automaton = compileProgramAutomaton(program)): FieldEngineState {
  return { ...seeded(program), compiled_automaton: automaton };
}

function resumeOn(
  state: FieldEngineState,
  rows: Iterable<AdjacencyRow>,
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

function counting(rows: readonly AdjacencyRow[], visits: { count: number }): Iterable<AdjacencyRow> {
  return { *[Symbol.iterator]() { for (const row of rows) { visits.count += 1; yield row; } } };
}

function byJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function project(state: FieldEngineState) {
  const bindings = state.binding.kind !== "bound" ? state.binding.kind : state.binding.snapshot.values.map((value) => ({
    subject: productSubjectId(value.state), hypothesis: value.state.hypothesis_id, binding: value.state.binding_context,
    program: value.state.program_state, accepting: value.accepting === true, grade: value.milligrades ?? null
  })).sort(byJson);
  const transitions = state.transitions.map((row) => ({
    instance: row.instance_id ?? null, kind: row.relation_kind, grade: row.strength_milligrades,
    from: productSubjectId(row.from), to: productSubjectId(row.to)
  })).sort(byJson);
  const derivations = state.derivations.map((row) => ({
    id: row.derivation_id, kind: row.kind, leaves: [...row.leaf_ids].sort(), grade: row.association_milligrades ?? null
  })).sort(byJson);
  return { bindings, transitions, derivations, guards: state.observation_gaps?.guards === true,
    pending: state.pending_path_effects !== undefined };
}

function leafIds(state: FieldEngineState): string[] {
  return [...new Set(state.derivations.flatMap((row) => row.leaf_ids))].sort();
}

function reachNames(owner: object, sequence: QueryProgram, from: string, assertionId: string): boolean {
  const reach = readSequenceReach(owner, sequenceReachKey(sequence, from));
  if (reach === undefined) return false;
  const ids = new Set(reach.derivations.flatMap((row) => row.leaf_ids));
  if (ids.has(assertionId)) return true;
  return reach.transitions.some((row) => row.instance_id === assertionId)
    || reach.unresolved.some((row) => row.row.assertionId === assertionId);
}

function orSequenceProgram(): { program: QueryProgram; sequence: QueryProgram } {
  const inner: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [hop("p", "x", "m")] };
  const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps: [inner, hop("r", "m", "y")] };
  return { program: sequenceHyperedge(sequence.steps), sequence };
}

describe("sequence reach lifecycle", () => {
  it("uses a fixed-size structural program identity across fresh program objects", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const key = sequenceReachKey(program, "seed");
    expect(key).toMatch(/^[a-f0-9]{64}\u0000seed$/);
    expect(sequenceReachKey(structuredClone(program), "seed")).toBe(key);
    expect(sequenceReachKey(sequenceHyperedge([hop("q", "x", "m"), hop("p", "m", "y")]), "seed"))
      .not.toBe(key);
  });

  it("does not publish sequence reach before its program identity fits the cursor allowance", () => {
    const program = sequenceHyperedge([hop("p", "x", "m"), hop("q", "m", "y")]);
    const state = withAutomaton(program);
    const owner = {};
    // The traversal retains 12,965 bytes before the persistent identity reservation.
    const memory = 12_965 + 63;
    const cursor = createAdjacencyEffectCursor([edge("p", "a", "m", "hop-p")], {
      interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: facts(["a", "m", "y"]),
      liveStates: state.seen_identities, compiledAutomaton: state.compiled_automaton, sequenceReachOwner: owner
    }, memory);
    expect(cursor).toBeDefined();
    const blocked = cursor!.advance(0, 200_000, memory);
    expect(blocked.status).toBe("memory_exhausted");
    expect(sequenceReachAccountBytes(owner)).toBe(0);
    const resumed = cursor!.advance(blocked.offset, 200_000, 1_000_000);
    expect(resumed.status).toBe("complete");
    expect(sequenceReachAccountBytes(owner)).toBeGreaterThan(64);
  });

  it("keeps unresolved sequence retention within memory and resumes without duplicate charge", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const program = sequenceHyperedge(steps);
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const state = withAutomaton(program);
    const rows = Array.from({ length: 200 }, (_, index) => edge("p", "a", `missing${index}`, `row${index}`));
    const source = facts(["a"]);
    const blocked = resumeOn({ ...state, remaining_memory_bytes: 172_500 }, rows, source);
    expect(blocked.remaining_memory_bytes).toBeGreaterThanOrEqual(0);
    expect(blocked.memory_exhausted).toBe(true);
    expect(blocked.pending_path_effects).toBeDefined();
    expect(sequenceReachAccountBytes(blocked.sequence_reach_owner)).toBe(0);
    for (let retry = 0; retry < 3; retry += 1) {
      const repeated = resumePathEffects({ ...blocked, memory_exhausted: false });
      expect(repeated.remaining_memory_bytes).toBe(blocked.remaining_memory_bytes);
      expect(repeated.pending_path_effects?.retained_bytes).toBe(blocked.pending_path_effects?.retained_bytes);
      expect(repeated.admitted_allocation_bytes).toBe(blocked.admitted_allocation_bytes);
      expect(sequenceReachAccountBytes(repeated.sequence_reach_owner)).toBe(0);
      expect(repeated.memory_exhausted).toBe(true);
    }
    const cancelled = withdrawDerivationLeaves(blocked, "row0");
    expect(cancelled.pending_path_effects?.retained_bytes).toBe(0);
    expect(cancelled.sequence_reach_owner).not.toBe(blocked.sequence_reach_owner);
    expect(sequenceReachAccountBytes(cancelled.sequence_reach_owner)).toBe(0);
    expect(cancelled.remaining_memory_bytes + (cancelled.solver_retained_bytes ?? 0)
      - blocked.remaining_memory_bytes - (blocked.solver_retained_bytes ?? 0)).toBe(
      blocked.pending_path_effects!.retained_bytes + (blocked.pending_path_effects?.preparation?.retained_bytes ?? 0));
    const resumed = resumePathEffects({ ...blocked, remaining_memory_bytes: 1_000_000,
      remaining_exploration: 200_000, memory_exhausted: false });
    expect(resumed.remaining_memory_bytes).toBeGreaterThanOrEqual(0);
    expect(resumed.memory_exhausted).toBe(false);
    const owner = sequenceOwner(resumed, state.compiled_automaton!);
    const reach = readSequenceReach(owner, sequenceReachKey(sequence, productStateNodeId(state.seen_identities.at(0)!)));
    expect(reach?.unresolved).toHaveLength(rows.length);
    expect(resumed.sequence_reach_bytes).toBe(64 + Buffer.byteLength(JSON.stringify(reach), "utf8"));
    expect(resumed.sequence_reach_bytes).toBe(sequenceReachAccountBytes(owner));
    expect(resumed.observation_gaps?.guards).toBe(true);
    expect(leafIds(resumed)).toEqual([]);
  });

  it("releases unresolved cache retention without changing a sibling owner", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const program = sequenceHyperedge(steps);
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const state = withAutomaton(program);
    const rows = Array.from({ length: 32 }, (_, index) => edge("p", "a", `missing${index}`, `row${index}`));
    const warmed = resumeOn(state, rows, facts(["a"]));
    const key = sequenceReachKey(sequence, productStateNodeId(state.seen_identities.at(0)!));
    const owner = sequenceOwner(warmed, state.compiled_automaton!);
    const charge = sequenceReachAccountBytes(owner);
    expect(readSequenceReach(owner, key)?.unresolved).toHaveLength(rows.length);
    const withdrawn = withdrawDerivationLeaves(warmed, "row0");
    expect(withdrawn.sequence_reach_owner).not.toBe(owner);
    expect(readSequenceReach(owner, key)?.unresolved).toHaveLength(rows.length);
    expect(readSequenceReach(withdrawn.sequence_reach_owner!, key)?.unresolved).toHaveLength(rows.length - 1);
    expect(withdrawn.pending_path_effects?.retained_bytes ?? 0).toBe(0);
    expect(withdrawn.remaining_memory_bytes + (withdrawn.solver_retained_bytes ?? 0)
      - warmed.remaining_memory_bytes - (warmed.solver_retained_bytes ?? 0)).toBe(
      (warmed.pending_path_effects?.retained_bytes ?? 0) + (warmed.pending_path_effects?.preparation?.retained_bytes ?? 0)
      + charge - sequenceReachAccountBytes(withdrawn.sequence_reach_owner));
    let released = withdrawn;
    for (const row of rows.slice(1)) released = withdrawDerivationLeaves(released, row.assertionId);
    expect(sequenceReachAccountBytes(released.sequence_reach_owner)).toBe(0);
    expect(released.sequence_reach_bytes).toBe(0);
    expect(readSequenceReach(released.sequence_reach_owner!, key)).toBeUndefined();
    expect(sequenceReachAccountBytes(owner)).toBe(charge);
    expect(released.remaining_memory_bytes).toBeGreaterThanOrEqual(0);
  });

  it("invalidates a sequence hop when its assertion is withdrawn", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const kept = edge("q", "m", "y", "hop-q");
    const source = facts(["a", "m", "y", "w"]);
    const warmed = resumeOn(state, [edge("p", "a", "m", "hop-p"), kept], source);
    const from = productStateNodeId(state.seen_identities.at(0)!);
    const withdrawn = withdrawDerivationLeaves(warmed, "hop-p");
    const owner = sequenceOwner(withdrawn, automaton);
    const noise = edge("q", "z", "w", "noise-row");
    const population = [edge("p", "a", "m", "hop-p"), kept, noise];
    const visits = { count: 0 };
    const incremental = resumeOn(withdrawn, counting(population, visits), source, [noise]);
    expect(reachNames(owner, sequence, from, "hop-p")).toBe(false);
    expect(visits.count).toBe(0);
    expect(leafIds(withdrawn)).not.toContain("hop-p");
    expect(leafIds(incremental)).not.toContain("hop-p");
    expect(project(incremental).transitions).toEqual(project(withdrawn).transitions);
    expect(project(incremental).derivations).toEqual(project(withdrawn).derivations);
  });

  it("rebuilds sequence reach from the full retained population", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const first = edge("p", "a", "m", "hop-p");
    const second = edge("q", "m", "y", "hop-q");
    const source = facts(["a", "m", "y"]);
    const partial = resumeOn(state, [first], source);
    const from = productStateNodeId(state.seen_identities.at(0)!);
    const key = sequenceReachKey(sequence, from);
    const owner = sequenceOwner(partial, automaton);
    const stored = readSequenceReach(owner, key);
    expect(stored?.transitions.length).toBeGreaterThan(0);
    const stale = stored!.transitions[0]!;
    writeSequenceReach(owner, key, { ...stored!, transitions: [...stored!.transitions, { ...stale, instance_id: "stale-hop" }],
      roots: { ...stored!.roots } });
    const rebuilt = resumeOn(partial, [first, second], source);
    const fresh = resumeOn(withAutomaton(program), [first, second], source);
    const after = readSequenceReach(sequenceOwner(rebuilt, automaton), key);
    expect(project(rebuilt)).toEqual(project(fresh));
    expect(after?.transitions.some((row) => row.instance_id === "stale-hop")).toBe(false);
    expect(after?.derivations.some((row) => row.leaf_ids.includes("hop-q"))).toBe(true);
  });

  it("replays a refused sequence admission and charges the restored cache once", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const first = edge("p", "a", "m", "hop-p");
    const second = edge("q", "m", "y", "hop-q");
    const source = facts(["a", "m", "y"]);
    const warmed = resumeOn(state, [first], source);
    expect(warmed.pending_path_effects).toBeUndefined();
    expect(warmed.sequence_reach_bytes).toBeGreaterThan(0);
    let refused: FieldEngineState | undefined;
    let probed: FieldEngineState | undefined;
    for (let memory = 4_000; memory < 160_000 && refused === undefined; memory += 250) {
      const candidate = resumePathEffects({
        ...warmed, remaining_exploration: 40_000, remaining_memory_bytes: memory, memory_exhausted: false,
        retention_rejected: undefined,
        pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(warmed),
          input: { rows: [first, second], options: {
            interpretation: warmed.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [second],
            liveStates: warmed.seen_identities, facets: warmed.facets, discoveries: warmed.discoveries,
            bindingContexts: warmed.binding_contexts, compiledAutomaton: automaton
          } } }
      });
      probed = candidate;
      if (candidate.retention_rejected !== undefined && candidate.pending_path_effects !== undefined) refused = candidate;
    }
    expect(refused, JSON.stringify({
      rejected: probed?.retention_rejected ?? null,
      exhausted: probed?.memory_exhausted ?? null,
      pending: probed?.pending_path_effects !== undefined
    })).toBeDefined();
    const replayed = resumePathEffects({ ...refused!, remaining_exploration: 200_000, remaining_memory_bytes: 1_000_000,
      memory_exhausted: false, retention_rejected: undefined });
    const fresh = resumeOn(withAutomaton(program), [first, second], source);
    const owner = sequenceOwner(replayed, automaton);
    expect(replayed.pending_path_effects).toBeUndefined();
    expect(project(replayed)).toEqual(project(fresh));
    const reach = readSequenceReach(owner, sequenceReachKey(sequence, productStateNodeId(state.seen_identities.at(0)!)));
    expect(replayed.sequence_reach_bytes).toBe(sequenceReachAccountBytes(owner));
    expect(replayed.sequence_reach_bytes).toBe(64 + Buffer.byteLength(JSON.stringify(reach), "utf8"));
    expect(replayed.sequence_reach_bytes).toBeGreaterThan(0);
  });

  it("restores the sequence cache on the field footprint and reuses it", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const first = edge("p", "a", "m", "hop-p");
    const source = facts(["a", "m", "y", "w"]);
    const warmed = resumeOn(state, [first], source);
    const fee = warmed.sequence_reach_bytes ?? 0;
    const from = productStateNodeId(state.seen_identities.at(0)!);
    expect(fee).toBeGreaterThan(0);
    expect(restoredFieldFootprint(warmed) - restoredFieldFootprint({ ...warmed, sequence_reach_bytes: 0 })).toBe(fee);
    const budget = 2_000_000;
    const restoredRemaining = budget - restoredFieldFootprint(warmed);
    const noise = edge("q", "z", "w", "noise-row");
    const visits = { count: 0 };
    const restored = resumePathEffects({
      ...warmed, remaining_exploration: 200_000, remaining_memory_bytes: restoredRemaining,
      memory_exhausted: false, retention_rejected: undefined,
      pending_path_effects: { offset: 0, retained_bytes: 0, page: observerPage(warmed),
        input: { rows: counting([first, noise], visits), options: {
          interpretation: warmed.interpretation, asOf: AS_OF, overlay: {}, sourceFacts: source, joinRows: [noise],
          liveStates: warmed.seen_identities, facets: warmed.facets, discoveries: warmed.discoveries,
          bindingContexts: warmed.binding_contexts, compiledAutomaton: automaton
        } } }
    });
    const owner = sequenceOwner(restored, automaton);
    expect(restored.pending_path_effects).toBeUndefined();
    expect(visits.count).toBe(0);
    expect(readSequenceReach(owner, sequenceReachKey(sequence, from))?.transitions.length).toBeGreaterThan(0);
    expect(restored.sequence_reach_bytes).toBe(sequenceReachAccountBytes(owner));
    expect(restoredFieldFootprint(restored) - restoredFieldFootprint({ ...restored, sequence_reach_bytes: 0 }))
      .toBe(restored.sequence_reach_bytes);
  });

  it("releases the sequence cache charge when the cache is dropped", () => {
    const steps = [hop("p", "x", "m"), hop("q", "m", "y")];
    const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
    const program = sequenceHyperedge(steps);
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const source = facts(["a", "m", "y"]);
    const warmed = resumeOn(state, [edge("p", "a", "m", "only-p")], source);
    const from = productStateNodeId(state.seen_identities.at(0)!);
    const fee = warmed.sequence_reach_bytes ?? 0;
    const dropped = withdrawDerivationLeaves(warmed, "only-p");
    const owner = sequenceOwner(dropped, automaton);
    expect(fee).toBeGreaterThan(0);
    expect(warmed.transitions).toHaveLength(0);
    expect({
      account: sequenceReachAccountBytes(owner),
      charged: dropped.sequence_reach_bytes ?? 0,
      stored: readSequenceReach(owner, sequenceReachKey(sequence, from)) !== undefined,
      net: fee + ((dropped.sequence_reach_bytes ?? 0) - fee)
    }).toEqual({ account: 0, charged: 0, stored: false, net: 0 });
  });
});

describe("sequence reach branch isolation", () => {
  it("keeps independent or support on a branch that withdrew a different child", () => {
    const { program, sequence } = orSequenceProgram();
    const automaton = compileProgramAutomaton(program);
    const state = withAutomaton(program, automaton);
    const p1 = edge("p", "a", "m", "p1");
    const p2 = edge("p", "a", "m", "p2");
    const r1 = edge("r", "m", "y", "r1");
    const source = facts(["a", "m", "y"]);
    const warmed = resumeOn(state, [p1, p2], source);
    const from = productStateNodeId(state.seen_identities.at(0)!);
    const branch1 = withdrawDerivationLeaves(warmed, "p1");
    const branch2 = withdrawDerivationLeaves(warmed, "p2");
    const resumed1 = resumeOn(branch1, [p2, r1], source, [r1]);
    const resumed2 = resumeOn(branch2, [p1, r1], source, [r1]);
    const fresh1 = resumeOn(withAutomaton(program), [p2, r1], source);
    const fresh2 = resumeOn(withAutomaton(program), [p1, r1], source);
    expect(branch1.withdrawn_leaves).toEqual(["p1"]);
    expect(branch2.withdrawn_leaves).toEqual(["p2"]);
    expect(reachNames(sequenceOwner(branch2, automaton), sequence, from, "p1")).toBe(true);
    expect(reachNames(sequenceOwner(branch2, automaton), sequence, from, "p2")).toBe(false);
    expect(reachNames(sequenceOwner(branch1, automaton), sequence, from, "p2")).toBe(true);
    expect(reachNames(sequenceOwner(branch1, automaton), sequence, from, "p1")).toBe(false);
    expect(project(resumed2)).toEqual(project(fresh2));
    expect(project(resumed1)).toEqual(project(fresh1));
    expect(leafIds(resumed2)).toContain("p1");
    expect(leafIds(resumed2)).not.toContain("p2");
    expect(leafIds(resumed1)).toContain("p2");
    expect(leafIds(resumed1)).not.toContain("p1");
  });
});

function nativeProgram(): QueryProgram {
  const andPremise: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and",
    premises: [hop("p", "x", "y"), hop("q", "x", "y")] };
  const orPremise: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [
    { schema_version: 1, kind: "alternative", options: [hop("r", "x", "y"), hop("s", "x", "y")] }
  ] };
  const sequencePremise: QueryProgram = { schema_version: 1, kind: "sequence",
    steps: [hop("t", "x", "m"), hop("u", "m", "y")] };
  return { schema_version: 1, kind: "hyperedge", join: "and", premises: [andPremise, orPremise, sequencePremise] };
}

function nativeReaders(rows: readonly ReturnType<typeof edge>[], pageSize: number): ObserverReaders {
  return {
    lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
    source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active",
      scope_class: "project" }, rowsRead: 1, bytesRead: 32, unavailable: false }),
    relation: ({ subject, predicate, afterAssertionId, limit, nativeLimit }) => {
      const remaining = rows.filter((row) => row.sourceObjectId === subject && row.predicate === predicate
        && row.assertionId > (afterAssertionId ?? "")).sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      const observations = remaining.slice(0, Math.min(pageSize, limit, nativeLimit));
      return { observations, nativeVisits: observations.length, nativeBytes: observations.length, rowsRead: observations.length,
        bytesRead: observations.length, truncated: observations.length < remaining.length,
        committedThrough: observations.at(-1)?.assertionId ?? afterAssertionId };
    }
  };
}

function kindSet(state: FieldEngineState): string[] {
  return [...new Set(state.derivations.map((row) => row.kind))].sort();
}

describe("native hyperedge premise control", () => {
  it("matches a fresh full run for and, or, and sequence premises", () => {
    const program = nativeProgram();
    const rows = [
      edge("p", "a", "y", "and-p"), edge("p", "a", "y", "and-p-2"), edge("q", "a", "y", "and-q"),
      edge("r", "a", "y", "or-r"), edge("s", "a", "y", "or-s"),
      edge("t", "a", "m", "seq-t"), edge("u", "m", "y", "seq-u")
    ];
    const interpretation = query(program);
    const budget = defaultBudget({ work_units: 200_000, memory_bytes: 5_000_000, finalization_reserve: 0, min_envelope: 0 });
    const request = { workspace_id: "workspace-1", query_text: "native-hyperedge", as_of: AS_OF, authorized_scopes: null, budget };
    const incremental = observeField(interpretation, { ...request, readers: nativeReaders(rows, 1) });
    const fresh = observeField(interpretation, { ...request, readers: nativeReaders(rows, 1_000) });
    expect(incremental.pending_path_effects).toBeUndefined();
    expect(fresh.pending_path_effects).toBeUndefined();
    const incrementalProof = project(incremental);
    const freshProof = project(fresh);
    expect({ bindings: incrementalProof.bindings, transitions: incrementalProof.transitions, guards: incrementalProof.guards })
      .toEqual({ bindings: freshProof.bindings, transitions: freshProof.transitions, guards: freshProof.guards });
    expect(kindSet(fresh)).toEqual(expect.arrayContaining(["and", "or", "serial"]));
    expect(kindSet(incremental)).toEqual(expect.arrayContaining(["and", "or", "serial"]));
    for (const id of ["and-p", "and-q", "or-r", "or-s", "seq-t", "seq-u"]) {
      expect(leafIds(fresh)).toContain(id);
      expect(leafIds(incremental)).toContain(id);
    }
  });
});
