import { describe, expect, it } from "vitest";
import { productStateKeyFromIndexEntry, sharedProductIdentity, type Guard, type QueryHypothesis,
  type QueryProgram } from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { RelationObserverRow, SourceObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import { productComponentState, productUpdatesBetween, type ProductComponentState }
  from "../../../../recall/conditional-field/index/product-component-diff.js";
import { OPEN_GUARD } from "./relation-grounding.fixture.js";
import { coalesceQualifiedResults, finiteExpressionDenotation, type FiniteExpression, type FiniteRelation,
  type FiniteWorld, type QualifiedResult } from "./qualified-expression.oracle.js";
import { extractQualifiedResults, observeQualifiedExpression, projectQualifiedExpression }
  from "./qualified-expression-native.fixture.js";

const CLOCK = "2026-09-10T00:00:00.000Z";
const START = "2026-01-01T00:00:00.000Z";
const HYPOTHESES: QueryHypothesis[] = [{ schema_version: 1, hypothesis_id: "h0",
  bindings: [{ schema_version: 1, variable: "c", value: "G" }] }];

function atom(kind: string): QueryProgram {
  const guard: Guard = OPEN_GUARD;
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: "x", target_variable: "y",
    guard, facet_mode: "same_path", threshold_milligrades: 0 };
}
const finiteAtom = (relation: string): FiniteExpression => ({ kind: "atom", relation, source: "x", target: "y" });
const OBJECTS = ["A", "T", "G"] as const;

type Case = Readonly<{ program: QueryProgram; expression: FiniteExpression; rows: readonly string[] }>;
// (a AND b) OR c with one shared result endpoint.
const AND_OR: Case = { rows: ["a", "b", "c"],
  program: { schema_version: 1, kind: "alternative", options: [
    { schema_version: 1, kind: "hyperedge", join: "and", premises: [atom("a"), atom("b")] }, atom("c")] },
  expression: { kind: "alternative", terms: [{ kind: "and", terms: [finiteAtom("a"), finiteAtom("b")] }, finiteAtom("c")] } };
// Two hard-identity alternatives of equal grade to the same endpoint.
const EQUAL_GRADE: Case = { rows: ["p", "q"],
  program: { schema_version: 1, kind: "alternative", options: [atom("p"), atom("q")] },
  expression: { kind: "alternative", terms: [finiteAtom("p"), finiteAtom("q")] } };

function world(input: Case, present: readonly string[]) {
  const rows: FiniteRelation[] = present.map((id) => ({ id, source: "A", target: "T", predicate: id,
    revision: `edge-revision-${id}`, valid_from: START }));
  const nativeRows: RelationObserverRow[] = rows.map((row) => ({ assertionId: row.id, sourceObjectId: "A",
    targetObjectId: "T", resultObjectId: "T", predicate: row.predicate, source_revision: row.revision,
    validity: { kind: "open", valid_from: START } }));
  const sources = Object.fromEntries(OBJECTS.map((id) => [id, { revision: `rev-${id}`, scope: "project" }]));
  const native: Record<string, SourceObserverRow> = Object.fromEntries(OBJECTS.map((id) =>
    [id, { object_id: id, sourceRevision: `rev-${id}`, lifecycle_state: "active", scope_class: "project" }]));
  const finite: FiniteWorld = { rows, sources, asOf: CLOCK, authorizedScopes: null,
    contractId: hardIdentityCapContractId(), seeds: [{ object: "A", hypothesis: "h0", bindings: { c: "G" } }] };
  return { finite, nativeRows, native, input };
}
type World = ReturnType<typeof world>;
const origins = (rows: readonly RelationObserverRow[]) =>
  new Map(rows.map((row) => [row.assertionId, { id: row.assertionId, revision: row.source_revision! }]));
const observeOptions = (w: World) => ({ seeds: ["A"], hypotheses: HYPOTHESES, sources: w.native, authorizedScopes: null, asOf: CLOCK });

function observe(w: World, resume?: FieldEngineState): FieldEngineState {
  return observeQualifiedExpression(w.input.program, w.nativeRows, { ...observeOptions(w), ...(resume ? { resume } : {}) });
}
function results(state: FieldEngineState, all: readonly RelationObserverRow[]): QualifiedResult[] {
  return coalesceQualifiedResults(extractQualifiedResults(state, origins(all)));
}
function withdrawRows(full: World, state: FieldEngineState, removed: readonly string[]) {
  let withdrawn = state;
  for (const id of removed) withdrawn = withdrawDerivationLeaves(withdrawn, id);
  const after = world(full.input, full.input.rows.filter((id) => !removed.includes(id)));
  return { after, withdrawn, resumed: observe(after, withdrawn), fresh: observe(after) };
}
function components(state: FieldEngineState): Map<string, ProductComponentState> {
  return new Map(projectQualifiedExpression(state).entries.map((entry) =>
    [sharedProductIdentity(productStateKeyFromIndexEntry(entry)), productComponentState(entry)]));
}
const supportsOf = (rows: readonly QualifiedResult[]) => rows.map((row) => row.supports.map((s) => s.map((k) => JSON.parse(k)[0])));

describe("row withdrawal matches a fresh qualified rebuild", () => {
  it.each([
    ["c leaves (a AND b) OR c", AND_OR, ["c"], [[["a", "b"]]]],
    ["a leaves (a AND b) OR c", AND_OR, ["a"], [[["c"]]]],
    ["a and c leave (a AND b) OR c", AND_OR, ["a", "c"], []],
    ["one equal-grade alternative leaves", EQUAL_GRADE, ["p"], [[["q"]]]],
    ["both equal-grade alternatives leave", EQUAL_GRADE, ["p", "q"], []]
  ] as const)("%s", (_name, input, removed, handSupports) => {
    const full = world(input, input.rows);
    const state = observe(full);
    expect(results(state, full.nativeRows)).toEqual(finiteExpressionDenotation(input.expression, full.finite).results);
    const { after, withdrawn, resumed, fresh } = withdrawRows(full, state, removed);
    const expected = finiteExpressionDenotation(input.expression, after.finite).results;
    const sort = (rows: readonly (readonly string[])[]) => rows.map((row) => [...row].sort()).sort();
    expect(supportsOf(expected).map(sort)).toEqual(handSupports.map((rows) => sort(rows as readonly (readonly string[])[])));
    for (const candidate of [withdrawn, resumed]) {
      expect(results(candidate, full.nativeRows)).toEqual(expected);
      expect(results(candidate, full.nativeRows)).toEqual(results(fresh, after.nativeRows));
    }
    expect(components(resumed)).toEqual(components(fresh));
    expect(components(withdrawn)).toEqual(components(fresh));
  });

  it("an unchanged grade with a lost alternative still changes the delivered explanation revision", () => {
    const full = world(EQUAL_GRADE, EQUAL_GRADE.rows);
    const before = components(observe(full));
    const { fresh, resumed } = withdrawRows(full, observe(full), ["p"]);
    const after = components(resumed);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const key = [...before.keys()][0]!;
    const entry = projectQualifiedExpression(resumed).entries[0]!;
    // Hand-derived: grade stays at the hard-identity top while one of two explanations disappears.
    expect(entry.association_milligrades).toBe(1000);
    const [oldRoot] = projectQualifiedExpression(observe(full)).entries[0]!.explanation_ids;
    // The old OR root named both alternatives; the surviving root names only the q route.
    expect(oldRoot).toContain("leaf:p:");
    expect(entry.explanation_ids).toHaveLength(1);
    expect(entry.explanation_ids[0]).not.toContain("leaf:p:");
    expect(entry.explanation_ids[0]).toContain("leaf:q:");
    expect(after.get(key)!.proof_revision).toBe(before.get(key)!.proof_revision);
    expect(after.get(key)!.membership_revision).toBe(before.get(key)!.membership_revision);
    expect(after.get(key)!.explanation_revision).not.toBe(before.get(key)!.explanation_revision);
    const updates = productUpdatesBetween(productStateKeyFromIndexEntry(entry), before.get(key), after.get(key));
    expect(updates.map((update) => update.update_kind)).toEqual(["payload"]);
    expect(after.get(key)).toEqual(components(fresh).get(key));
  });
});
