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
const SCHEDULE_LIMIT = 160;
const LISTING_LIMIT = 320;

type Edge = { assertionId: string; sourceObjectId: string; targetObjectId: string; predicate: string };
type TopologyName = "DIAMOND" | "DIAMOND_Q" | "ONLY";
type ReaderMode = "keep" | "drop";
type ListedField = { work: number; state: FieldEngineState };

function rel(kind: string, source: string, target: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    facet_mode: "same_path", threshold_milligrades: 0, guard: GUARD };
}
function seq(...steps: QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "sequence", steps };
}
function hp(...premises: QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "hyperedge", join: "and", premises };
}
function alt(...options: QueryProgram[]): QueryProgram {
  return { schema_version: 1, kind: "alternative", options };
}

const SHAPES: Record<string, QueryProgram> = {
  "seq(p,r)": seq(rel("p", "x", "y"), rel("r", "y", "z")),
  "hp(seq)": hp(seq(rel("p", "x", "y"), rel("r", "y", "z"))),
  "seq(hp(p),r)": seq(hp(rel("p", "x", "y")), rel("r", "y", "z")),
  "alt(seq|seq)": alt(seq(rel("p", "x", "y"), rel("r", "y", "z")), seq(rel("q", "x", "y"), rel("r", "y", "z"))),
  "seq(alt(p|q),r)": seq(alt(rel("p", "x", "y"), rel("q", "x", "y")), rel("r", "y", "z")),
  "alt(p|q)": alt(rel("p", "x", "y"), rel("q", "x", "y"))
};

const DIAMOND: Edge[] = [
  { assertionId: "p1", sourceObjectId: "a", targetObjectId: "b", predicate: "p" },
  { assertionId: "p2", sourceObjectId: "a", targetObjectId: "c", predicate: "p" },
  { assertionId: "r1", sourceObjectId: "b", targetObjectId: "d", predicate: "r" },
  { assertionId: "r2", sourceObjectId: "c", targetObjectId: "e", predicate: "r" }
];
const DIAMOND_Q: Edge[] = [
  { assertionId: "p1", sourceObjectId: "a", targetObjectId: "b", predicate: "p" },
  { assertionId: "q1", sourceObjectId: "a", targetObjectId: "c", predicate: "q" },
  { assertionId: "r1", sourceObjectId: "b", targetObjectId: "d", predicate: "r" },
  { assertionId: "r2", sourceObjectId: "c", targetObjectId: "e", predicate: "r" }
];
const ONLY: Edge[] = [
  { assertionId: "p1", sourceObjectId: "a", targetObjectId: "b", predicate: "p" },
  { assertionId: "r1", sourceObjectId: "b", targetObjectId: "d", predicate: "r" }
];
const EDGES: Record<TopologyName, readonly Edge[]> = { DIAMOND, DIAMOND_Q, ONLY };

const SAME_PREDICATE = ["seq(p,r)", "hp(seq)", "seq(hp(p),r)"] as const;
const TWO_PREDICATE = ["alt(seq|seq)", "seq(alt(p|q),r)", "alt(p|q)"] as const;
const LISTED_CASES: Array<[string, TopologyName, ReaderMode]> = [
  ...[...SAME_PREDICATE, ...TWO_PREDICATE].flatMap((shape) =>
    (["keep", "drop"] as const).map((mode) => [shape, "DIAMOND" as const, mode] as [string, TopologyName, ReaderMode])),
  ...TWO_PREDICATE.flatMap((shape) =>
    (["keep", "drop"] as const).map((mode) => [shape, "DIAMOND_Q" as const, mode] as [string, TopologyName, ReaderMode])),
  ...[...SAME_PREDICATE, ...TWO_PREDICATE].flatMap((shape) =>
    (["keep", "drop"] as const).map((mode) => [shape, "ONLY" as const, mode] as [string, TopologyName, ReaderMode]))
];

function worksThrough(limit: number): number[] {
  const works: number[] = [];
  for (let work = 10; work <= limit; work += 10) works.push(work);
  return works;
}

function readers(edges: readonly Edge[]): ObserverReaders {
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

function interpretation(program: QueryProgram): QueryInterpretation {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, query_id: "stepped-row-withdrawal", status: "resolved",
    snapshot_id: SNAPSHOT_ID, program, view: defaultView(), holes: [], hypotheses: [] };
}

function run(program: QueryProgram, edges: readonly Edge[], work: number, resume?: FieldEngineState): FieldEngineState {
  return observeField(interpretation(program), {
    workspace_id: "w", query_text: "a", as_of: AS_OF, authorized_scopes: null,
    budget: defaultBudget({ work_units: work }), readers: readers(edges), resume_field: resume
  });
}

function accepted(state: FieldEngineState): string[] {
  if (state.binding.kind !== "bound") return [state.binding.kind];
  return state.binding.snapshot.values.filter((value) => value.accepting && value.activation?.kind === "reachable")
    .map((value) => JSON.stringify(Object.fromEntries(parseBindingContext(value.state.binding_context, state.binding_contexts))))
    .sort();
}

function listed(state: FieldEngineState, id: string): boolean {
  return [...state.observed_relations ?? []].some((row) => row.assertionId === id);
}

function joined(state: FieldEngineState, id: string): boolean {
  return state.derivations.some((row) => row.leaf_ids.includes(id));
}

function stalled(state: FieldEngineState, step: number): boolean {
  if (state.binding.kind !== "bound") return true;
  if (state.pending_path_effects !== undefined) return false;
  if (state.last_observer_status === "exhausted") return true;
  return step > 0 && [...state.observed_relations ?? []].length === 0;
}

function findListed(program: QueryProgram, edges: readonly Edge[]): ListedField | undefined {
  for (const work of worksThrough(LISTING_LIMIT)) {
    let state = run(program, edges, work);
    for (let step = 0; step < 30; step += 1) {
      if (listed(state, "p1")) return { work, state };
      if (stalled(state, step)) break;
      state = run(program, edges, work, state);
    }
  }
  return undefined;
}

function findUnjoinedAlternate(program: QueryProgram, edges: readonly Edge[]): ListedField | undefined {
  for (const work of worksThrough(SCHEDULE_LIMIT)) {
    let state = run(program, edges, work);
    for (let step = 0; step < 30; step += 1) {
      if (state.pending_path_effects === undefined && listed(state, "p1") && listed(state, "p2") && !joined(state, "p2")) {
        return { work, state };
      }
      if (stalled(state, step)) break;
      state = run(program, edges, work, state);
    }
  }
  return undefined;
}

function untilObserverExhausted(program: QueryProgram, edges: readonly Edge[], work: number, start: FieldEngineState): FieldEngineState {
  let state = start;
  for (let step = 0; step < 40; step += 1) {
    if (state.pending_path_effects === undefined && state.closure.propagation === "fixed_point"
      && state.last_observer_status === "exhausted") return state;
    state = run(program, edges, work, state);
  }
  return state;
}

function withoutP1(edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.assertionId !== "p1");
}

function survivor(shape: string, topology: TopologyName): string[] {
  if (topology === "ONLY") return [];
  if (shape === "alt(p|q)") return [JSON.stringify({ x: "a", y: "c" })];
  return [JSON.stringify({ x: "a", y: "c", z: "e" })];
}

function expectMatchesFresh(shape: string, topology: TopologyName, mode: ReaderMode, found: ListedField): void {
  const program = SHAPES[shape]!;
  const edges = mode === "drop" ? withoutP1(EDGES[topology]) : EDGES[topology];
  const oracle = run(program, withoutP1(EDGES[topology]), 100_000);
  const done = untilObserverExhausted(program, edges, found.work, withdrawDerivationLeaves(found.state, "p1"));
  const label = `${shape} ${topology} readers=${mode} work=${found.work}`;
  expect(accepted(oracle), label).toEqual(survivor(shape, topology));
  expect(accepted(done), label).toEqual(accepted(oracle));
  expect(done.closure, label).toEqual(oracle.closure);
  expect(done.pending_path_effects, label).toBeUndefined();
  expect(done.last_observer_status, label).toBe("exhausted");
}

it("withdraws a listed diamond row before the other intermediate is joined", () => {
  const program = SHAPES["hp(seq)"]!;
  const found = findUnjoinedAlternate(program, DIAMOND);
  expect(found).toBeDefined();
  const state = found!.state;
  const rows = [...state.observed_relations ?? []];
  expect(state.pending_path_effects).toBeUndefined();
  expect(rows.find((row) => row.assertionId === "p1")?.targetObjectId).toBe("b");
  expect(rows.find((row) => row.assertionId === "p2")?.targetObjectId).toBe("c");
  expect(joined(state, "p2")).toBe(false);
  expect(found!.work).toBeGreaterThanOrEqual(10);
  expect(found!.work).toBeLessThanOrEqual(SCHEDULE_LIMIT);
  for (const mode of ["keep", "drop"] as const) expectMatchesFresh("hp(seq)", "DIAMOND", mode, found!);
});

it.each(LISTED_CASES)("%s %s readers=%s matches a fresh recompute after the listed row is withdrawn", (shape, topology, mode) => {
  const found = findListed(SHAPES[shape]!, EDGES[topology]);
  expect(found, `${shape} ${topology}`).toBeDefined();
  expect([...found!.state.observed_relations ?? []].some((row) => row.assertionId === "p1")).toBe(true);
  expectMatchesFresh(shape, topology, mode, found!);
});
