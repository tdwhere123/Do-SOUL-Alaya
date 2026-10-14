import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger, type ProductStateKey, type QueryProgram } from "@do-soul/alaya-protocol";
import { createConditionalField, type FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { compileProgramAutomaton } from "../../../recall/conditional-field/engine/program-automaton.js";
import { pairKey } from "../../../recall/conditional-field/engine/path-routing.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import type { SourceSemanticExecutionPlan } from "../../../recall/conditional-field/query/compile-source-semantic-finite.js";
import { sourceSemanticBranchAttention } from "../../../recall/runtime/source-semantic-attention.js";
import { defaultBudget, productKey } from "../conditional-field/reference/deployment.fixture.js";
import { edge, query as fieldQuery, relation } from "../conditional-field/engine/relation-grounding.fixture.js";
import { correspondenceFor, ORIGINAL, query, source } from "./source-semantic-proof-fixture.js";

function admission() {
  const interpretation = source(), semantics = query();
  const result = admitSourceSemanticCorrespondence({ source_interpretation: interpretation,
    query_semantics: semantics, semantic_correspondence: correspondenceFor(interpretation, semantics),
    original_query: ORIGINAL });
  if (result.kind !== "admitted") throw new Error("attention fixture must be admitted");
  return result;
}

function fixture(program: QueryProgram) {
  const automaton = compileProgramAutomaton(program);
  const products = automaton.advances.map((advance, index) => productKey(`subject-${index}`, "h0", "unbound", advance.from));
  const state = createConditionalField({ interpretation: fieldQuery(program), budget: defaultBudget(), seeds: [] });
  const execution: SourceSemanticExecutionPlan = { program, missingOperands: false, branches: [{
    purpose: "support", alternative: 0, obligations: [{ relation_kind: "wanted", source_variable: "x",
      alternative: 0, frame: "query-frame", obligation: "predicate" }]
  }] };
  return { execution, products, state: { ...state, compiled_automaton: automaton, seen_identities: products,
    closure: { ...state.closure, observation: "open" as const } } };
}

function compute(input: ReturnType<typeof fixture>, work = 100_000) {
  const meter = new SourceSemanticResourceLedger({ work_units: work, memory_bytes: 1_000_000 });
  const result = sourceSemanticBranchAttention(admission(), input.execution, input.state, new Set([0]), meter);
  return { result, meter };
}

function pairScope(subject: string, product: ProductStateKey) {
  return { kind: "pair", subject_id: subject, product };
}

describe("semantic attention reached products", () => {
  it("reports a reached obligation within a budget that excludes unrelated control-state rescans", () => {
    const input = fixture({ schema_version: 1, kind: "sequence", steps: [relation("wanted"),
      ...Array.from({ length: 127 }, (_, index) => relation(`unrelated-${index}`))] });
    const { result, meter } = compute(input, 1_000);
    expect(result?.truncated).toBe(false);
    expect(result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "unobserved", observation: "unknown", scope: pairScope("subject-0", input.products[0]!) }]);
    expect(meter.spentWork).toBeLessThan(1_000);
  });

  it("reports a reached obligation within a budget that excludes unrelated observed rows and transitions", () => {
    const input = fixture(relation("wanted"));
    const reached = input.products[0]!;
    const extras = Array.from({ length: 48 }, (_, index) =>
      productKey(`extra-${index}`, "h0", "unbound", reached.program_state));
    let pair_demands = input.state.pair_demands;
    let pair_progress = input.state.pair_progress;
    const observed_relations = [];
    const transitions = [];
    for (const [index, extra] of extras.entries()) {
      const subject = `extra-${index}`;
      const key = pairKey(subject, "wanted");
      pair_demands = pair_demands.with(key, true);
      pair_progress = pair_progress.with(`${key}:done`, null);
      observed_relations.push(edge("wanted", subject, "target", `wanted-${index}`),
        edge("unrelated", `other-${index}`, "target", `unrelated-${index}`));
      transitions.push({
        schema_version: 1 as const, from: extra, to: productKey("target"), relation_kind: "wanted",
        strength_milligrades: 1000, validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
        applicable: true
      }, {
        schema_version: 1 as const, from: productKey(`other-${index}`), to: productKey("target"),
        relation_kind: "unrelated", strength_milligrades: 1000,
        validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" }, applicable: true
      });
    }
    input.state = { ...input.state, seen_identities: [reached, ...extras], pair_demands, pair_progress,
      pair_completed_count: extras.length, observed_relations, transitions };
    const { result, meter } = compute(input, 1_000);
    expect(result?.truncated).toBe(false);
    expect(result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "unobserved", observation: "unknown", scope: pairScope("subject-0", reached) }]);
    expect(meter.spentWork).toBeLessThan(1_000);
  });

  it("keeps completed pairs separate from open pairs and sibling product identities", () => {
    const input = fixture(relation("wanted"));
    const first = input.products[0]!;
    const sibling = { ...first, hypothesis_id: "other-hypothesis" };
    const open = productKey("open-subject", "h0", "unbound", first.program_state);
    const completeKey = pairKey("subject-0", "wanted"), openKey = pairKey("open-subject", "wanted");
    input.state = { ...input.state, seen_identities: [first, sibling, open], memory_exhausted: true,
      pair_demands: input.state.pair_demands.with(completeKey, true).with(openKey, true),
      pair_progress: input.state.pair_progress.with(`${completeKey}:done`, null), pair_completed_count: 1 };
    const { result } = compute(input);
    expect(result?.entries.map(({ state, observation, scope }) => ({ state, observation, scope }))).toEqual([
      { state: "correspondence_missing", observation: "exhausted", scope: pairScope("subject-0", first) },
      { state: "correspondence_missing", observation: "exhausted", scope: pairScope("subject-0", sibling) },
      { state: "resource_incomplete", observation: "open", scope: pairScope("open-subject", open) }
    ]);
  });

  it("does not treat a NUL-split pair as the observed subject and predicate", () => {
    const kind = "b\0c";
    const input = fixture(relation(kind));
    const product = productKey("a", "h0", "unbound", input.products[0]!.program_state);
    const key = pairKey("a", kind);
    input.execution = { ...input.execution, branches: [{ purpose: "support", alternative: 0, obligations: [{
      relation_kind: kind, source_variable: "x", alternative: 0, frame: "query-frame", obligation: "predicate"
    }] }] };
    input.state = { ...input.state, seen_identities: [product],
      pair_demands: input.state.pair_demands.with(key, true),
      pair_progress: input.state.pair_progress.with(`${key}:done`, null), pair_completed_count: 1,
      observed_relations: [edge("c", "a\0b", "target", "colliding-row")] };
    expect(compute(input).result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "correspondence_missing", observation: "exhausted", scope: pairScope("a", product) }]);
  });

  it("observes a predicate that contains NUL when the subject matches exactly", () => {
    const kind = "b\0c";
    const input = fixture(relation(kind));
    const product = productKey("a", "h0", "unbound", input.products[0]!.program_state);
    const sibling = { ...product, hypothesis_id: "other-hypothesis" };
    const key = pairKey("a", kind);
    input.execution = { ...input.execution, branches: [{ purpose: "support", alternative: 0, obligations: [{
      relation_kind: kind, source_variable: "x", alternative: 0, frame: "query-frame", obligation: "predicate"
    }] }] };
    input.state = { ...input.state, seen_identities: [product, sibling],
      pair_demands: input.state.pair_demands.with(key, true),
      pair_progress: input.state.pair_progress.with(`${key}:done`, null), pair_completed_count: 1,
      observed_relations: [edge(kind, "a", "target", "exact-row")],
      transitions: [{ schema_version: 1, from: product, to: productKey("target"), relation_kind: kind,
        strength_milligrades: 1000, validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
        applicable: false }] };
    expect(compute(input).result?.entries.map(({ state, observation, scope }) => ({ state, observation, scope })))
      .toEqual([{ state: "unknown", observation: "exhausted", scope: pairScope("a", sibling) }]);
  });

  it("does not index relations when closure already makes the branch unavailable", () => {
    const input = fixture(relation("wanted"));
    input.state = { ...input.state, closure: { ...input.state.closure, observation: "unavailable" },
      observed_relations: Array.from({ length: 400 }, (_, index) => edge("wanted", `s-${index}`, "target", `row-${index}`)),
      transitions: Array.from({ length: 400 }, (_, index) => ({ schema_version: 1 as const,
        from: productKey(`from-${index}`), to: productKey("target"), relation_kind: "wanted",
        strength_milligrades: 1000, validity: { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" },
        applicable: false })) };
    const { result, meter } = compute(input, 200);
    expect(result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "unavailable", observation: "unavailable", scope: { kind: "branch" } }]);
    expect(meter.spentWork).toBeLessThan(200);
  });

  it("does not let an admitted transition close a sibling product", () => {
    const input = fixture(relation("wanted"));
    const first = input.products[0]!, sibling = { ...first, hypothesis_id: "other-hypothesis" };
    const key = pairKey("subject-0", "wanted");
    const state: FieldEngineState = { ...input.state, seen_identities: [first, sibling],
      pair_demands: input.state.pair_demands.with(key, true),
      pair_progress: input.state.pair_progress.with(`${key}:done`, null), pair_completed_count: 1,
      observed_relations: [edge("wanted", "subject-0", "target", "observed-edge")],
      transitions: [{ schema_version: 1, from: first, to: productKey("target"), relation_kind: "wanted",
        strength_milligrades: 1000, validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, applicable: true }] };
    const meter = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 });
    const result = sourceSemanticBranchAttention(admission(), input.execution, state, new Set([0]), meter);
    expect(result?.entries.map(({ state, observation, scope }) => ({ state, observation, scope }))).toEqual([
      { state: "unknown", observation: "exhausted", scope: pairScope("subject-0", sibling) }
    ]);
  });

  it("keeps distinct relation occurrences unattributable even when one product is reached", () => {
    const input = fixture({ schema_version: 1, kind: "sequence", steps: [relation("wanted"), relation("wanted")] });
    input.state = { ...input.state, seen_identities: input.products.slice(0, 1) };
    expect(compute(input).result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "unknown", observation: "unknown", scope: { kind: "branch" } }]);
  });

  it("keeps each reached state of a repeated relation and leaves missing provenance unobserved", () => {
    const input = fixture({ schema_version: 1, kind: "repeat", body: relation("wanted"), count: 2 });
    expect(compute(input).result?.entries.map((entry) => entry.scope)).toEqual(
      input.products.map((product, index) => pairScope(`subject-${index}`, product)));
    const missing = fixture(relation("unrelated"));
    expect(compute(missing).result?.entries).toEqual([{ alternative: 0, frame: "query-frame", obligation: "predicate",
      state: "unobserved", observation: "unknown", scope: { kind: "branch" } }]);
  });
});
