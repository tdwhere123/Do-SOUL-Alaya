import { productSubjectId, type Guard, type QueryInterpretation, type QueryProgram } from "@do-soul/alaya-protocol";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { AdjacencyRow } from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import type { FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { BoundSourceFacts } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

export const AS_OF = "2026-09-10T00:00:00.000Z";
export const OPEN_GUARD = { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } as const;
export const AUTH_GUARD: Guard = { schema_version: 1, kind: "authorization", variable: "c",
  authorization_scope: "project", time_scope: "none", verdict: "unresolved" };

export function relation(name: string, target = "y", guard: Guard = OPEN_GUARD): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: name, source_variable: "x", target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard };
}

export function query(program: QueryProgram, patch: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return { schema_version: 1, query_id: "relation-row-increment", snapshot_id: SNAPSHOT_ID, status: "resolved",
    holes: [], hypotheses: [], program, view: defaultView(), ...patch };
}

export function edge(predicate: string, source: string, target: string, id: string): AdjacencyRow & { resultObjectId: string } {
  return { assertionId: id, sourceObjectId: source, targetObjectId: target, resultObjectId: target, predicate,
    source_revision: "rev", validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" } };
}

export function facts(ids: readonly string[], scope?: Readonly<Record<string, string>>): Map<string, BoundSourceFacts> {
  return new Map(ids.map((object_id) => [object_id, {
    object_id, source_revision: "rev", ...(scope?.[object_id] === undefined ? {} : { scope_class: scope[object_id] })
  }]));
}

export function project(state: FieldEngineState) {
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

export function sequenceHyperedge(steps: readonly QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "hyperedge", join: "and", premises: [
    { schema_version: 1, kind: "alternative", options: [{ schema_version: 1, kind: "sequence", steps }] }
  ] };
}

export function storedFacts(ids: readonly string[]): PersistentStringMap<BoundSourceFacts> {
  let stored = new PersistentStringMap<BoundSourceFacts>();
  for (const object_id of ids) stored = stored.with(object_id, { object_id, source_revision: "rev" });
  return stored;
}
