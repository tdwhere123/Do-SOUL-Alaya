import { describe, expect, it } from "vitest";
import { productSubjectId, type ObserverPage, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import type { AdjacencyRow } from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import {
  createConditionalField,
  withdrawDerivationLeaves,
  type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { seedProgramStates } from "../../../../recall/conditional-field/engine/path-composition-seed.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import { ObservedRelations } from "../../../../recall/conditional-field/engine/observed-relations.js";
import { sequenceReachAccountBytes } from "../../../../recall/conditional-field/engine/sequence-reach.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { ExplanationDelivery } from "../../../../recall/conditional-field/index/explanation-delivery.js";
import { restoredFieldFootprint, restoredFieldRemainingMemory } from "../../../../recall/runtime/request-cost-engine-snapshot.js";
import { resumePathEffects } from "../../../../recall/runtime/pending-path-effects.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-10T00:00:00.000Z";
const OPEN_GUARD = { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } as const;

function hop(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD };
}

function sequenceHyperedge(steps: readonly QueryProgram[]): QueryProgram {
  const sequence: QueryProgram = { schema_version: 1, kind: "sequence", steps };
  return { schema_version: 1, kind: "hyperedge", join: "and", premises: [
    { schema_version: 1, kind: "alternative", options: [sequence] }
  ] };
}

function orSequenceProgram(): QueryProgram {
  const inner: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "or", premises: [hop("p", "x", "m")] };
  return sequenceHyperedge([inner, hop("r", "m", "y")]);
}

function query(program: QueryProgram): QueryInterpretation {
  return { schema_version: 1, query_id: "withdraw-after-complete", snapshot_id: SNAPSHOT_ID, status: "resolved",
    holes: [], hypotheses: [], program, view: defaultView() };
}

function edge(predicate: string, source: string, target: string, id: string): AdjacencyRow {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, predicate, source_revision: "rev",
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
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

function withAutomaton(program: QueryProgram): FieldEngineState {
  return { ...seeded(program), compiled_automaton: compileProgramAutomaton(program) };
}

function observerPage(state: FieldEngineState, status: "open" | "exhausted"): ObserverPage {
  return { schema_version: 1, query_id: state.query_id, snapshot_id: state.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: state.query_id,
      snapshot_id: state.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status }, open_regions: [] };
}

function resumeOn(
  state: FieldEngineState,
  rows: readonly AdjacencyRow[],
  sourceFacts: ReadonlyMap<string, BoundSourceFacts>,
  exploration = 200_000
): FieldEngineState {
  return resumePathEffects({
    ...state,
    remaining_exploration: exploration,
    memory_exhausted: false,
    retention_rejected: undefined,
    pending_path_effects: {
      offset: 0, retained_bytes: 0, page: observerPage(state, exploration < 200_000 ? "open" : "exhausted"),
      input: { rows, options: {
        interpretation: state.interpretation, asOf: AS_OF, overlay: {}, sourceFacts,
        liveStates: state.seen_identities, facets: state.facets, discoveries: state.discoveries,
        bindingContexts: state.binding_contexts, compiledAutomaton: state.compiled_automaton
      } }
    }
  });
}

function byJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function proof(state: FieldEngineState) {
  const bindings = state.binding.kind !== "bound" ? state.binding.kind : state.binding.snapshot.values.map((value) => ({
    subject: productSubjectId(value.state), hypothesis: value.state.hypothesis_id, binding: value.state.binding_context,
    program: value.state.program_state, accepting: value.accepting === true, grade: value.milligrades ?? null
  })).sort(byJson);
  const transitions = state.transitions.map((row) => ({
    instance: row.instance_id ?? null, kind: row.relation_kind, grade: row.strength_milligrades,
    from: productSubjectId(row.from), to: productSubjectId(row.to)
  })).sort(byJson);
  return { bindings, transitions, guards: state.observation_gaps?.guards === true };
}

/** Field terms of the shared completion check. Proof and index terms stay with the projection. */
function admitsFieldComplete(state: FieldEngineState): boolean {
  return state.binding.kind === "bound" && state.binding.solver_complete === true
    && state.closure.observation === "exhausted" && !state.memory_exhausted && state.remaining_work.length === 0;
}

function observeObligation(state: FieldEngineState): boolean {
  return state.remaining_work.some((row) => row.kind === "observe");
}

describe("withdraw after a path pass", () => {
  it("releases discarded proof cursors without refunding admitted allocation", () => {
    const initial = seeded(hop("p", "x", "y"));
    const grounding = groundedOutputDerivations({ seeds: initial.seeds, transitions: [], derivations: [],
      transition_derivations: {}, allowance: 3, memory_bytes: 10_000 }).progress;
    const explanation = new ExplanationDelivery([], [], undefined, 1, 224);
    const proofBytes = grounding.retained_bytes + explanation.retainedBytes;
    expect(proofBytes).toBeGreaterThan(0);
    const priorFootprint = restoredFieldFootprint(initial);
    const before = { ...initial, grounding_progress: grounding, explanation_progress: explanation,
      remaining_memory_bytes: initial.remaining_memory_bytes - proofBytes,
      accounted_retained_bytes: priorFootprint + proofBytes };
    const baseline = withdrawDerivationLeaves(initial, "withdrawn");
    const after = withdrawDerivationLeaves(before, "withdrawn");
    expect(after.grounding_progress).toBeUndefined();
    expect(after.explanation_progress).toBeUndefined();
    expect(after.remaining_memory_bytes).toBe(baseline.remaining_memory_bytes);
    expect(after.accounted_retained_bytes).toBe(priorFootprint);
    expect(restoredFieldRemainingMemory(after, initial.budget.memory_bytes))
      .toBe(restoredFieldRemainingMemory(baseline, initial.budget.memory_bytes));
    expect(after.admitted_allocation_bytes - before.admitted_allocation_bytes)
      .toBe(baseline.admitted_allocation_bytes - initial.admitted_allocation_bytes);
  });

  it("does not invent a path-effect input when no pass has started", () => {
    const program = orSequenceProgram();
    const withdrawn = withdrawDerivationLeaves(withAutomaton(program), "p2");
    expect(withdrawn.pending_path_effects).toBeUndefined();
    expect(withdrawn.path_effect_frontier).toBeUndefined();
    expect(observeObligation(withdrawn)).toBe(false);
  });

  it("keeps a finished pass open until the retained rows are run again", () => {
    const program = orSequenceProgram();
    const source = facts(["a", "m", "y"]);
    const p1 = edge("p", "a", "m", "p1");
    const p2 = edge("p", "a", "m", "p2");
    const r1 = edge("r", "m", "y", "r1");
    const proved = resumeOn(withAutomaton(program), [p1, p2, r1], source);
    expect(proved.pending_path_effects).toBeUndefined();
    expect(proved.path_effect_frontier).toBeDefined();
    const withdrawn = withdrawDerivationLeaves(proved, "p2");
    expect(withdrawn.pending_path_effects).toBeUndefined();
    expect(withdrawn.path_effect_frontier).toBeUndefined();
    expect(withdrawn.closure.observation).toBe("open");
    expect(observeObligation(withdrawn)).toBe(true);
    expect(admitsFieldComplete(withdrawn)).toBe(false);
    const resumed = resumeOn(withdrawn, [p1, r1], source);
    const fresh = resumeOn(withAutomaton(program), [p1, r1], source);
    expect(proof(resumed)).toEqual(proof(fresh));
    expect(observeObligation(resumed)).toBe(false);
    expect(admitsFieldComplete(resumed)).toBe(admitsFieldComplete(fresh));
    expect(resumed.sequence_reach_bytes ?? 0).toBe(sequenceReachAccountBytes(resumed.sequence_reach_owner));
  });

  it("restarts an interrupted pass from the retained rows and charges that owner once", () => {
    const program = orSequenceProgram();
    const source = facts(["a", "m", "y"]);
    const p1 = edge("p", "a", "m", "p1");
    const p2 = edge("p", "a", "m", "p2");
    const r1 = edge("r", "m", "y", "r1");
    const warmed = resumeOn(withAutomaton(program), [p1, p2], source);
    expect(warmed.sequence_reach_bytes ?? 0).toBeGreaterThan(0);
    const interrupted = resumeOn(warmed, [p1, p2, r1], source, 1);
    const pending = interrupted.pending_path_effects;
    const scratch = (pending?.retained_bytes ?? 0) + (pending?.preparation?.retained_bytes ?? 0);
    expect(pending?.cursor).toBeDefined();
    expect(scratch).toBeGreaterThan(0);
    expect(pending?.input.options.sequenceReachOwner).toBeDefined();
    const withdrawn = withdrawDerivationLeaves(interrupted, "p2");
    const rebuilt = withdrawn.pending_path_effects;
    expect(rebuilt?.cursor).toBeUndefined();
    expect(rebuilt?.preparation).toBeUndefined();
    expect(rebuilt?.offset).toBe(0);
    expect(rebuilt?.retained_bytes).toBe(0);
    expect(rebuilt?.input.options.sequenceReachOwner).toBeUndefined();
    expect(rebuilt?.input.options.joinRows).toBeUndefined();
    expect(rebuilt?.input.options.liveStateOffset).toBe(0);
    expect([...rebuilt?.input.rows ?? []].map((row) => row.assertionId).sort()).toEqual(["p1", "r1"]);
    expect(withdrawn.closure.observation).toBe("open");
    expect(observeObligation(withdrawn)).toBe(true);
    expect(admitsFieldComplete(withdrawn)).toBe(false);
    expect(withdrawn.closure.propagation === "fixed_point" && admitsFieldComplete(withdrawn)).toBe(false);
    expect(withdrawn.sequence_reach_bytes ?? 0).toBe(sequenceReachAccountBytes(withdrawn.sequence_reach_owner));
    const resumed = resumePathEffects({
      ...withdrawn, remaining_exploration: 200_000, remaining_memory_bytes: 1_000_000,
      memory_exhausted: false, retention_rejected: undefined
    });
    const fresh = resumeOn(withAutomaton(program), [p1, r1], source);
    expect(resumed.pending_path_effects).toBeUndefined();
    expect(proof(resumed)).toEqual(proof(fresh));
    expect(observeObligation(resumed)).toBe(false);
    expect(resumed.sequence_reach_bytes ?? 0).toBe(sequenceReachAccountBytes(resumed.sequence_reach_owner));
  });

  it("leaves a listed relation on the derivation graph when the sequence frontier is still charged", () => {
    const program = orSequenceProgram();
    const source = facts(["a", "m", "y"]);
    const proved = resumeOn(withAutomaton(program), [edge("p", "a", "m", "p1"), edge("p", "a", "m", "p2"), edge("r", "m", "y", "r1")], source);
    expect(proved.pending_path_effects).toBeUndefined();
    expect(proved.path_effect_frontier).toBeDefined();
    expect(proved.sequence_reach_bytes ?? 0).toBeGreaterThan(0);
    const listed = {
      ...proved,
      observed_relations: new ObservedRelations().with({
        assertionId: "p2", sourceObjectId: "a", targetObjectId: "m", resultObjectId: "m", predicate: "p"
      })
    };
    const withdrawn = withdrawDerivationLeaves(listed, "p2");
    expect(withdrawn.pending_path_effects).toBeUndefined();
    expect(withdrawn.path_effect_frontier).toBe(proved.path_effect_frontier);
    expect(observeObligation(withdrawn)).toBe(false);
    expect(withdrawn.last_observer_status).toBe(proved.last_observer_status);
  });

  it("does not open a rebuild when a charged sequence has no path frontier", () => {
    const program = orSequenceProgram();
    const source = facts(["a", "m", "y"]);
    const proved = resumeOn(withAutomaton(program), [edge("p", "a", "m", "p1"), edge("p", "a", "m", "p2"), edge("r", "m", "y", "r1")], source);
    expect(proved.sequence_reach_bytes ?? 0).toBeGreaterThan(0);
    const withdrawn = withdrawDerivationLeaves({ ...proved, path_effect_frontier: undefined }, "p2");
    expect(withdrawn.pending_path_effects).toBeUndefined();
    expect(withdrawn.path_effect_frontier).toBeUndefined();
    expect(observeObligation(withdrawn)).toBe(false);
  });
});
