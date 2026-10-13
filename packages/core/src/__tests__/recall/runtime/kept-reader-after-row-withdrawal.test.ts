import { expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { parseBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import type { ObserverReaders } from "../../../recall/conditional-field/observers/observe.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { SNAPSHOT_ID, defaultBudget, defaultView } from "../conditional-field/reference/deployment.fixture.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-10T00:00:00.000Z";
const GUARD = { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } as const;

function relation(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard: GUARD };
}

const PROGRAM: QueryProgram = { schema_version: 1, kind: "alternative", options: [
  { schema_version: 1, kind: "hyperedge", join: "and", premises: [
    { schema_version: 1, kind: "sequence", steps: [
      { schema_version: 1, kind: "hyperedge", join: "and", premises: [relation("observed_log", "x", "y")] }
    ] },
    relation("service_history", "x", "z")
  ] },
  relation("config_direct", "x", "y")
] };

const EDGES = [
  { assertionId: "p1", sourceObjectId: "a", targetObjectId: "b", predicate: "observed_log" },
  { assertionId: "p2", sourceObjectId: "a", targetObjectId: "b", predicate: "observed_log" },
  { assertionId: "q1", sourceObjectId: "a", targetObjectId: "c", predicate: "config_direct" },
  { assertionId: "r1", sourceObjectId: "a", targetObjectId: "d", predicate: "service_history" }
] as const;

function interpretation(): QueryInterpretation {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, query_id: "kept-reader-withdrawal", status: "resolved",
    snapshot_id: SNAPSHOT_ID, program: PROGRAM, view: defaultView(), holes: [], hypotheses: [] };
}

function readers(edges: readonly (typeof EDGES)[number][]): ObserverReaders {
  return {
    lexical: () => ({ ids: ["a"], nativeVisits: 1, nativeBytes: 1, rowsRead: 1, bytesRead: 1, truncated: false }),
    source: ({ objectId }) => ({ row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active",
      scope_class: "project" }, rowsRead: 1, bytesRead: 1, unavailable: false }),
    relation: ({ subject, predicate }) => {
      const observations = edges.filter((edge) => (subject === null || edge.sourceObjectId === subject) && edge.predicate === predicate)
        .map((edge) => ({ ...edge, resultObjectId: edge.targetObjectId, validity: VALIDITY, evidenceRefs: [`e-${edge.assertionId}`] }));
      return { observations, nativeVisits: observations.length, nativeBytes: 1, rowsRead: observations.length,
        bytesRead: 1, truncated: false };
    }
  };
}

function accepted(state: FieldEngineState): string[] {
  if (state.binding.kind !== "bound") return [state.binding.kind];
  return state.binding.snapshot.values.filter((value) => value.accepting && value.activation?.kind === "reachable")
    .map((value) => JSON.stringify(Object.fromEntries(parseBindingContext(value.state.binding_context, state.binding_contexts))))
    .sort();
}

function resumeAfterWithdraw(work: number, keepReader: boolean): FieldEngineState {
  const query = interpretation();
  let state = observeField(query, { workspace_id: "w", query_text: "a", as_of: AS_OF, authorized_scopes: null,
    budget: defaultBudget({ work_units: work }), readers: readers(EDGES) });
  state = withdrawDerivationLeaves(state, "p1");
  const edges = keepReader ? EDGES : EDGES.filter((edge) => edge.assertionId !== "p1");
  for (let step = 0; step < 60; step += 1) {
    const settled = state.pending_path_effects === undefined && state.closure.observation === "exhausted"
      && state.closure.propagation === "fixed_point";
    if (settled) break;
    state = observeField(query, { workspace_id: "w", query_text: "a", as_of: AS_OF, authorized_scopes: null,
      budget: defaultBudget({ work_units: work }), readers: readers(edges), resume_field: state });
  }
  return state;
}

function freshWithoutWithdrawnRow(): FieldEngineState {
  return observeField(interpretation(), { workspace_id: "w", query_text: "a", as_of: AS_OF, authorized_scopes: null,
    budget: defaultBudget({ work_units: 100_000 }), readers: readers(EDGES.filter((edge) => edge.assertionId !== "p1")) });
}

it("keeps the surviving sequence binding when the withdrawn row is still returned", () => {
  const oracle = freshWithoutWithdrawnRow();
  const kept = resumeAfterWithdraw(140, true);
  expect(accepted(oracle)).toEqual([
    JSON.stringify({ x: "a", y: "b", z: "d" }),
    JSON.stringify({ x: "a", y: "c" })
  ]);
  expect({
    accepted: accepted(kept),
    propagation: kept.closure.propagation,
    observation: kept.closure.observation,
    pending: kept.pending_path_effects !== undefined,
    reentered: [...kept.observed_relations ?? []].some((row) => row.assertionId === "p1")
  }).toEqual({
    accepted: accepted(oracle),
    propagation: oracle.closure.propagation,
    observation: oracle.closure.observation,
    pending: false,
    reentered: false
  });
});

it("matches that oracle when readers drop the withdrawn row", () => {
  const oracle = freshWithoutWithdrawnRow();
  const dropped = resumeAfterWithdraw(140, false);
  expect(accepted(dropped)).toEqual(accepted(oracle));
  expect(dropped.closure).toEqual(oracle.closure);
  expect(dropped.pending_path_effects).toBeUndefined();
});

it("stays interrupted when the same withdrawal still has exploration left", () => {
  for (const work of [40, 80, 120]) {
    const state = resumeAfterWithdraw(work, true);
    expect({ work, observation: state.closure.observation }).toEqual({ work, observation: "interrupted" });
  }
});
