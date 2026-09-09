import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  productSubjectId,
  type Derivation,
  type QueryInterpretation,
  type QueryProgram
} from "@do-soul/alaya-protocol";
import {
  applyObserverPage,
  createConditionalField,
  withdrawDerivationLeaves
} from "../../../../recall/conditional-field/engine/field-engine.js";
import {
  adjacencyEffectsForRows,
  seedProgramStates
} from "../../../../recall/conditional-field/engine/path-composition.js";
import {
  derivationForest,
  evaluateDerivation,
  joinDerivation,
  leafDerivation,
  withdrawDerivation
} from "../../../../recall/conditional-field/engine/path-derivation.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const VALIDITY = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
const OVERLAY = {
  rel_a: { milligrades: 800, applicable: true },
  rel_b: { milligrades: 800, applicable: true },
  rel_c: { milligrades: 800, applicable: true }
};

describe("equal-score AND/OR withdrawal", () => {
  it("withdrawing c distinguishes (a AND b) OR c from (a OR b) AND c", () => {
    const a = leafDerivation({ derivation_id: "a", observation_id: "a", leaf_id: "a" });
    const b = leafDerivation({ derivation_id: "b", observation_id: "b", leaf_id: "b" });
    const c = leafDerivation({ derivation_id: "c", observation_id: "c", leaf_id: "c" });
    const andAb = joinDerivation("and", [a, b]);
    const orLeft = joinDerivation("or", [andAb, c]);
    const orAb = joinDerivation("or", [a, b]);
    const andRight = joinDerivation("and", [orAb, c]);
    const forest = derivationForest([a, b, c, andAb, orLeft, orAb, andRight]);
    const grades = new Map([["a", 800], ["b", 800], ["c", 800]]);
    expect(evaluateDerivation(forest, orLeft.derivation_id, grades)).toBe(800);
    expect(evaluateDerivation(forest, andRight.derivation_id, grades)).toBe(800);
    expect(new Set(orLeft.leaf_ids)).toEqual(new Set(andRight.leaf_ids));
    const afterOr = withdrawDerivation(forest, orLeft.derivation_id, "c");
    const afterAnd = withdrawDerivation(forest, andRight.derivation_id, "c");
    expect(afterOr?.kind).toBe("and");
    expect(afterOr?.leaf_ids).toEqual(["a", "b"]);
    expect(afterAnd).toBeUndefined();
    expect(evaluateDerivation(derivationForest([a, b, andAb, afterOr as Derivation]), afterOr!.derivation_id, grades))
      .toBe(800);
  });

  it("field producer keeps (a AND b) after withdrawing c and drops (a OR b) AND c", () => {
    const rows = [
      edge("seed", "end", "rel_a", "a"),
      edge("seed", "end", "rel_b", "b"),
      edge("seed", "end", "rel_c", "c")
    ];
    const orOfAnd = fieldFor(hyperedge("or", [
      hyperedge("and", [rel("rel_a"), rel("rel_b")]),
      rel("rel_c")
    ]), rows);
    const andOfOr = fieldFor(hyperedge("and", [
      hyperedge("or", [rel("rel_a"), rel("rel_b")]),
      rel("rel_c")
    ]), rows);
    expect(gradeOf(orOfAnd, "end")).toBe(800);
    expect(gradeOf(andOfOr, "end")).toBe(800);
    const orLeaves = new Set(orOfAnd.derivations.flatMap((row) => row.leaf_ids));
    const andLeaves = new Set(andOfOr.derivations.flatMap((row) => row.leaf_ids));
    expect(orLeaves).toEqual(andLeaves);
    const afterOr = withdrawDerivationLeaves(orOfAnd, "c");
    const afterAnd = withdrawDerivationLeaves(andOfOr, "c");
    const freshOr = fieldFor(hyperedge("or", [
      hyperedge("and", [rel("rel_a"), rel("rel_b")]),
      rel("rel_c")
    ]), rows.filter((row) => row.assertionId !== "c"));
    expect(gradeOf(afterOr, "end")).toBe(gradeOf(freshOr, "end"));
    expect(gradeOf(afterOr, "end")).toBe(800);
    expect(gradeOf(afterAnd, "end")).toBe(0);
    expect(gradeOf(afterOr, "end")).not.toBe(gradeOf(afterAnd, "end"));
  });
});

function fieldFor(program: QueryProgram, rows: readonly ReturnType<typeof edge>[]) {
  const interpretation = interpretationOf(program);
  const seeds = seedProgramStates(program).map((programState) => ({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: "seed", source_revision: "rev" },
      program_state: programState,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    },
    milligrades: 1000
  }));
  const created = createConditionalField({
    interpretation,
    budget: defaultBudget(),
    seeds
  });
  return applyObserverPage(created, {
    page: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: interpretation.query_id,
      snapshot_id: SNAPSHOT_ID,
      cursor: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        cursor_id: "adjacency",
        snapshot_id: SNAPSHOT_ID,
        query_id: interpretation.query_id,
        region_id: "adjacency",
        position: null,
        committed_through: null
      },
      observations: [],
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
      open_regions: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        region_id: "adjacency",
        kind: "adjacency",
        status: "open"
      }]
    },
    effects: adjacencyEffectsForRows(rows, {
      interpretation,
      asOf: "2026-09-07T00:00:00.000Z",
      liveStates: created.seen_identities,
      overlay: OVERLAY
    })
  });
}

function interpretationOf(program: QueryProgram): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "withdrawal-probe",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function rel(relationKind: string): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: "x",
    target_variable: "y",
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict: "unresolved",
      time_scope: "none"
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function hyperedge(join: "and" | "or", premises: readonly QueryProgram[]): QueryProgram {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "hyperedge", join, premises };
}

function edge(
  sourceObjectId: string,
  targetObjectId: string,
  predicate: string,
  assertionId: string
) {
  return {
    assertionId,
    sourceObjectId,
    targetObjectId,
    predicate,
    validity: VALIDITY
  };
}

function gradeOf(state: ReturnType<typeof createConditionalField>, objectId: string): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((row) =>
    productSubjectId(row.state) === objectId && row.accepting
  )?.milligrades ?? 0;
}
