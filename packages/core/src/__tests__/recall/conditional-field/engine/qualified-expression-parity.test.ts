import { describe, expect, it } from "vitest";
import type { Guard, QueryHypothesis, QueryProgram } from "@do-soul/alaya-protocol";
import { hardIdentityCapContractId } from "../../../../recall/conditional-field/cap-contract.js";
import { withdrawDerivationLeaves } from "../../../../recall/conditional-field/engine/field-engine.js";
import type { RelationObserverRow, SourceObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import { OPEN_GUARD } from "./relation-grounding.fixture.js";
import { coalesceQualifiedResults, finiteExpressionDenotation,
  type FiniteExpression, type FiniteRelation, type FiniteSource, type FiniteWorld } from "./qualified-expression.oracle.js";
import { extractQualifiedResults, observeQualifiedExpression } from "./qualified-expression-native.fixture.js";

const CLOCK = "2026-09-10T00:00:00.000Z";
const START = "2026-01-01T00:00:00.000Z";
const GUARD: Guard = { schema_version: 1, kind: "authorization", variable: "c",
  authorization_scope: "project", time_scope: "none", verdict: "unresolved" };
const HYPOTHESES: QueryHypothesis[] = ["h0", "h1"].map((hypothesis_id) => ({ schema_version: 1,
  hypothesis_id, bindings: [{ schema_version: 1, variable: "c", value: "G" }] }));
const ROWS: readonly FiniteRelation[] = [
  ["p-A", "A", "M", "p"], ["p-alt-A", "A", "M", "p-alt"], ["p-B", "B", "N", "p"],
  ["q-M", "M", "Z", "q"], ["q-N", "N", "Z", "q"],
  ["r-A", "A", "M", "r"], ["r-B", "B", "N", "r"], ["r-conflict", "B", "M", "r"],
  ["s-M", "Z", "M", "s"], ["s-N", "Z", "N", "s"]
].map(([id, source, target, predicate]) => ({ id: id!, source: source!, target: target!, predicate: predicate!,
  revision: `edge-revision-${id}`, valid_from: START }));

const EXPRESSION: FiniteExpression = { kind: "and", terms: [
  { kind: "sequence", terms: [{ kind: "epsilon" }, { kind: "alternative", terms: [
    { kind: "atom", relation: "p", source: "x", target: "m" },
    { kind: "atom", relation: "p-alt", source: "x", target: "m" }, { kind: "empty" }
  ] }, { kind: "atom", relation: "q", source: "m", target: "z" }] },
  { kind: "sequence", terms: [{ kind: "atom", relation: "r", source: "x", target: "m" },
    { kind: "atom", relation: "s", source: "m", target: "z", inverse: true,
      guard: { variable: "c", scope: "project" } }] }
] };

function atom(kind: string, source: string, target: string, guard: Guard = OPEN_GUARD, threshold = 0): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: kind, source_variable: source, target_variable: target,
    guard, facet_mode: "same_path", threshold_milligrades: threshold };
}
const PROGRAM: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [
  { schema_version: 1, kind: "sequence", steps: [{ schema_version: 1, kind: "epsilon" },
    { schema_version: 1, kind: "alternative", options: [atom("p", "x", "m"), atom("p-alt", "x", "m"),
      { schema_version: 1, kind: "empty" }] }, atom("q", "m", "z")] },
  { schema_version: 1, kind: "sequence", steps: [atom("r", "x", "m"), atom("s-inverse", "m", "z", GUARD)] }
] };

function fixture(options: { guardScope?: "project" | "private" | "unknown"; privateAnchor?: boolean;
  expiredInverse?: boolean; authorizedScopes?: readonly string[] | null; reverse?: boolean } = {}) {
  const sources: Record<string, FiniteSource> = Object.fromEntries(["A", "B", "M", "N", "Z", "G"].map((id) =>
    [id, { revision: `rev-${id}`, scope: id === "B" && options.privateAnchor ? "private" : "project" }]));
  sources.G = { revision: "rev-G", ...(options.guardScope === "unknown" ? {} : { scope: options.guardScope ?? "project" }) };
  let rows = ROWS.map((row) => row.id === "s-N" && options.expiredInverse ? { ...row, valid_to: CLOCK } : row);
  if (options.reverse) rows = rows.reverse();
  const nativeRows: RelationObserverRow[] = rows.map((row, index) => ({
    // The reader orders physical IDs. Changing only input array order would not vary its pages.
    assertionId: `${options.reverse ? `order-${String(index).padStart(2, "0")}:` : ""}${row.predicate === "s" ? `reverse-${row.id}` : row.id}`,
    sourceObjectId: row.predicate === "s" ? row.target : row.source,
    targetObjectId: row.predicate === "s" ? row.source : row.target,
    resultObjectId: row.predicate === "s" ? row.source : row.target,
    predicate: row.predicate === "s" ? "s-inverse" : row.predicate, source_revision: row.revision,
    validity: row.valid_to === undefined ? { kind: "open", valid_from: row.valid_from }
      : { kind: "bounded", valid_from: row.valid_from, valid_to: row.valid_to } }));
  const origins = new Map(rows.map((row, index) => [nativeRows[index]!.assertionId, { id: row.id, revision: row.revision }]));
  const nativeSources: Record<string, SourceObserverRow> = Object.fromEntries(Object.entries(sources).map(([id, value]) =>
    [id, { object_id: id, sourceRevision: value.revision, lifecycle_state: "active", scope_class: value.scope }]));
  const world: FiniteWorld = { rows, sources, asOf: CLOCK, authorizedScopes: options.authorizedScopes ?? null,
    contractId: hardIdentityCapContractId(), seeds: ["A", "B"].flatMap((object) => HYPOTHESES.map((hypothesis) =>
      ({ object, hypothesis: hypothesis.hypothesis_id, bindings: { c: "G" } }))) };
  const nativeOptions = { seeds: ["A", "B"], hypotheses: HYPOTHESES, sources: nativeSources,
    authorizedScopes: world.authorizedScopes, asOf: CLOCK };
  return { world, nativeRows, origins, nativeOptions };
}

describe("qualified finite expression denotation", () => {
  it.each([1, 16])("preserves two anchors, full bindings and distinct proof alternatives with page size %s", (pageSize) => {
    for (const reverse of [false, true]) {
      const input = fixture({ reverse });
      const expected = finiteExpressionDenotation(EXPRESSION, input.world);
      const state = observeQualifiedExpression(PROGRAM, input.nativeRows, { ...input.nativeOptions, pageSize });
      expect(state.pending_path_effects).toBeUndefined();
      expect(state.closure.propagation).toBe("fixed_point");
      const actual = coalesceQualifiedResults(extractQualifiedResults(state, input.origins));
      expect(actual).toEqual(expected.results);
      expect(actual).toHaveLength(4);
      expect(actual.filter((row) => row.anchor === "A").map((row) => row.supports.length)).toEqual([2, 2]);
      expect(actual.flatMap((row) => row.supports.flat()).some((leaf) => leaf.includes("r-conflict"))).toBe(false);
    }
  });

  it.each(["unknown", "project", "private"] as const)("uses bound source facts for a %s guard completion", (guardScope) => {
    const input = fixture({ guardScope });
    const expected = finiteExpressionDenotation(EXPRESSION, input.world);
    const state = observeQualifiedExpression(PROGRAM, input.nativeRows, input.nativeOptions);
    expect(coalesceQualifiedResults(extractQualifiedResults(state, input.origins))).toEqual(expected.results);
    expect(state.observation_gaps?.guards === true).toBe(expected.unresolvedGuard);
    expect(state.source_facts?.get("G")?.scope_class).toBe(guardScope === "unknown" ? undefined : guardScope);
  });

  it("applies principal scope and half-open relation validity before qualified composition", () => {
    for (const options of [{ privateAnchor: true, authorizedScopes: ["project"] }, { expiredInverse: true }]) {
      const input = fixture(options);
      const expected = finiteExpressionDenotation(EXPRESSION, input.world);
      const state = observeQualifiedExpression(PROGRAM, input.nativeRows, input.nativeOptions);
      const actual = coalesceQualifiedResults(extractQualifiedResults(state, input.origins));
      expect(actual).toEqual(expected.results);
      expect(actual.map((row) => row.anchor)).toEqual(["A", "A"]);
    }
  });

  it("resumes interrupted observation and independently withdraws equal-grade alternatives", () => {
    const input = fixture();
    const interrupted = observeQualifiedExpression(PROGRAM, input.nativeRows, { ...input.nativeOptions, pageSize: 1, work: 180 });
    expect(interrupted.last_observer_status).toBe("interrupted");
    expect(() => extractQualifiedResults(interrupted, input.origins)).toThrow("unfinished");
    const completed = observeQualifiedExpression(PROGRAM, input.nativeRows, { ...input.nativeOptions, pageSize: 1, resume: interrupted });
    expect(coalesceQualifiedResults(extractQualifiedResults(completed, input.origins)))
      .toEqual(finiteExpressionDenotation(EXPRESSION, input.world).results);
    for (const removed of [["p-A"], ["p-alt-A"], ["p-A", "p-alt-A"], ["q-M"], ["s-M"]]) {
      let withdrawn = completed;
      for (const id of removed) withdrawn = withdrawDerivationLeaves(withdrawn, id === "s-M" ? `reverse-${id}` : id);
      const remainingRows = input.nativeRows.filter((row) => !removed.includes(input.origins.get(row.assertionId)!.id));
      const resumed = observeQualifiedExpression(PROGRAM, remainingRows, { ...input.nativeOptions, resume: withdrawn });
      const expected = finiteExpressionDenotation(EXPRESSION, { ...input.world, rows: input.world.rows.filter((row) => !removed.includes(row.id)) });
      expect(coalesceQualifiedResults(extractQualifiedResults(resumed, input.origins)), removed.join(",")).toEqual(expected.results);
    }
  });

  it("preserves epsilon entries, empty absence and strict atomic threshold equality", () => {
    const input = fixture();
    const cases: readonly (readonly [FiniteExpression, QueryProgram])[] = [
      [{ kind: "epsilon" }, { schema_version: 1, kind: "epsilon" }],
      [{ kind: "empty" }, { schema_version: 1, kind: "empty" }],
      [{ kind: "atom", relation: "p", source: "x", target: "m", threshold: 1000 }, atom("p", "x", "m", OPEN_GUARD, 1000)]
    ];
    for (const [expression, program] of cases) {
      const state = observeQualifiedExpression(program, input.nativeRows, input.nativeOptions);
      expect(coalesceQualifiedResults(extractQualifiedResults(state, input.origins)))
        .toEqual(finiteExpressionDenotation(expression, input.world).results);
    }
  });
});
