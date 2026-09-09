import { describe, expect, it } from "vitest";
import { productSubjectId, type QueryProgram, type QueryInterpretation, type Transition } from "@do-soul/alaya-protocol";
import { createConditionalField, applyObserverPage, withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { adjacencyEffectsForRows, seedProgramStates, composedFacetPathId } from "../../../../recall/conditional-field/engine/path-composition.js";
import { leafDerivation, joinDerivation, reviseDerivations, derivationForest, evaluateDerivation } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { evaluateGuard } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { assessUnknownCause } from "../../../../recall/runtime/semantic-attribution.js";

const validity: Transition["validity"] = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const rel = (relation_kind: string, source_variable = "x", target_variable = "y"): QueryProgram => ({ schema_version: 1, kind: "relation", relation_kind,
  source_variable, target_variable, guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" }, facet_mode: "same_path", threshold_milligrades: 0 });
const seq = (...steps: QueryProgram[]): QueryProgram => ({ schema_version: 1, kind: "sequence", steps });
const alt = (...options: QueryProgram[]): QueryProgram => ({ schema_version: 1, kind: "alternative", options });
const and = (...premises: QueryProgram[]): QueryProgram => ({ schema_version: 1, kind: "hyperedge", join: "and", premises });
const edge = (sourceObjectId: string, targetObjectId: string, predicate: string, assertionId = predicate) => ({ sourceObjectId, targetObjectId, predicate, assertionId, validity });
const overlay = Object.fromEntries(Object.entries({ a: 800, b: 800, c: 800, weak: 200, strong: 900, tail: 1000 }).map(([name, milligrades]) => [name, { milligrades, applicable: true }]));
function field(program: QueryProgram, rows: ReturnType<typeof edge>[]): FieldEngineState {
  const interpretation: QueryInterpretation = { schema_version: 1, query_id: "grounded", status: "resolved", snapshot_id: SNAPSHOT_ID, program, view: defaultView(), holes: [], hypotheses: [] };
  const seeds = seedProgramStates(program).map((program_state) => ({ schema_version: 1 as const, state: { schema_version: 1 as const,
    target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: "seed", source_revision: "rev" }, program_state, hypothesis_id: "h0", binding_context: "unbound", time_state: "as_of" }, milligrades: 1000 }));
  const initial = createConditionalField({ interpretation, budget: defaultBudget(), seeds });
  return applyObserverPage(initial, { page: { schema_version: 1, query_id: "grounded", snapshot_id: SNAPSHOT_ID,
    cursor: { schema_version: 1, cursor_id: "a", snapshot_id: SNAPSHOT_ID, query_id: "grounded", region_id: "adjacency", position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
    effects: adjacencyEffectsForRows(rows, {
      interpretation, asOf: "2026-09-07T00:00:00.000Z", liveStates: initial.seen_identities, overlay,
      sourceFacts: factsFor(rows)
    }) });
}
const grade = (state: FieldEngineState) => Math.max(0, ...(state.binding.kind === "bound" ? state.binding.snapshot.values.filter((value) => value.accepting && productSubjectId(value.state) === "end").map((value) => value.milligrades ?? 0) : []));
function factsFor(rows: readonly ReturnType<typeof edge>[]) {
  const facts = new Map<string, { object_id: string; source_revision: string }>();
  facts.set("seed", { object_id: "seed", source_revision: "rev" });
  for (const row of rows) {
    facts.set(row.sourceObjectId, { object_id: row.sourceObjectId, source_revision: "rev" });
    facts.set(row.targetObjectId, { object_id: row.targetObjectId, source_revision: "rev" });
  }
  return facts;
}

describe("grounded retained derivation revisions", () => {
  it.each(["transition", "derivation", "root-map", "source-revision"])("rebuilds same-count %s changes exactly as fresh grounding", (changedPart) => {
    const base = { ...field(rel("a"), [edge("seed", "end", "a")]),
      source_facts: { seed: { object_id: "seed", source_revision: "before" } }, allowance: 1_000 };
    const before = groundedOutputDerivations(base);
    const changed = {
      ...base,
      ...(changedPart === "transition" ? { transitions: base.transitions.map((edge) => ({ ...edge, applicable: false })) } : {}),
      ...(changedPart === "derivation" ? { derivations: base.derivations.map((node) => node.kind !== "leaf" ? node : {
        ...node, observation_ids: ["replacement"], leaf_ids: ["replacement"], source_revisions: ["after"] }) } : {}),
      ...(changedPart === "root-map" ? { transition_derivations: Object.fromEntries(
        Object.entries(base.transition_derivations).map(([key, root]) => [key, `retired:${root}`])) } : {}),
      ...(changedPart === "source-revision" ? { source_facts: { seed: { object_id: "seed", source_revision: "after" } } } : {})
    };
    const fresh = groundedOutputDerivations(changed);
    const resumed = groundedOutputDerivations({ ...changed, progress: before.progress });
    expect(resumed.derivations).toEqual(fresh.derivations);
    expect(resumed.roots).toEqual(fresh.roots);
    expect(resumed.complete).toBe(fresh.complete);
    expect(resumed.work).toBeGreaterThan(0);
  });

  it("rebuilds a retained root after a stronger same-snapshot seed merges without changing counts", () => {
    const base = field({ schema_version: 1, kind: "epsilon" }, []);
    const low = createConditionalField({ interpretation: base.interpretation, budget: base.budget,
      seeds: base.seeds.map((seed) => ({ ...seed, milligrades: 200 })) });
    const before = groundedOutputDerivations({ ...low, allowance: 100 });
    const stronger = applyObserverPage(low, { page: { schema_version: 1, query_id: low.query_id, snapshot_id: low.snapshot_id,
      cursor: { schema_version: 1, cursor_id: "seed", query_id: low.query_id, snapshot_id: low.snapshot_id,
        region_id: "seed", position: "stronger", committed_through: "stronger" },
      observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
      effects: [{ observation_id: "stronger-seed", seed: { ...low.seeds[0]!, milligrades: 900 } }] });
    expect(stronger.seeds).toHaveLength(low.seeds.length);
    expect(stronger.seeds[0]!.milligrades).toBe(900);
    const resumed = groundedOutputDerivations({ ...stronger, allowance: 100, progress: before.progress });
    expect(resumed.derivations.find((node) => node.kind === "leaf")?.association_milligrades).toBe(900);
    expect(resumed.work).toBeGreaterThan(0);
  });

  it("retains grounding progress beyond a fixed allowance and recovers identical complete roots", () => {
    const rows = Array.from({ length: 25 }, (_, index) => edge("seed", "end", "a", `assert-${index}`));
    const state = field(rel("a"), rows);
    const full = groundedOutputDerivations({ ...state, allowance: 10_000 });
    let step = groundedOutputDerivations({ ...state, allowance: 5 });
    let priorWork = -1;
    for (let attempt = 0; !step.complete && attempt < 200; attempt += 1) {
      expect(step.work).toBeLessThanOrEqual(5);
      expect(step.progress.completed_work).toBeGreaterThan(priorWork);
      priorWork = step.progress.completed_work;
      step = groundedOutputDerivations({ ...state, allowance: 5, progress: step.progress });
    }
    expect(step.complete).toBe(true);
    expect(step.roots).toEqual(full.roots);
    expect(step.derivations).toEqual(full.derivations);
  });

  it("assesses many actual receipts across exploration allowances without spending finalization reserve", () => {
    const row = edge("seed", "end", "a");
    let state = { ...field(rel("a"), [row]), observed_relations: [{ ...row, resultObjectId: "end",
      evidenceReceipts: Array.from({ length: 50 }, (_, index) => ({ evidenceId: `e${index}`, eventId: `event${index}`,
        eventType: "relation.evidence", occurredAt: "2026-09-06T00:00:00.000Z" })) }] } as FieldEngineState;
    const initialReserve = state.remaining_reserve;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      state = assessUnknownCause({ ...state, remaining_exploration: 30 }, { as_of: "2026-09-07T00:00:00.000Z" });
      expect(state.remaining_reserve).toBe(initialReserve);
      if (state.support_work_status === "complete") break;
    }
    expect(state.support_work_status).toBe("complete");
    const supported = state.support.find((record) => record.claim === "supported");
    expect(supported?.witnesses).toHaveLength(50);
    const repeat = assessUnknownCause({ ...state, remaining_exploration: 30 }, { as_of: "2026-09-07T00:00:00.000Z" });
    expect(repeat.remaining_exploration).toBe(30);
    expect(repeat.support).toEqual(state.support);
  });

  it("keeps supported context separate from an explicit causal demand and accepts grounded causality", () => {
    const row = edge("seed", "end", "a");
    const initial = field(rel("a"), [row]);
    const observed = { ...row, resultObjectId: "end", evidenceReceipts: [{ evidenceId: "e-context", eventId: "event-context",
      eventType: "relation.evidence", occurredAt: "2026-09-06T00:00:00.000Z" }] };
    const configured: FieldEngineState = { ...initial, observed_relations: [observed], interpretation: { ...initial.interpretation,
      view: { ...initial.interpretation.view, claim_demands: [{ variable: "y", proposition_kind: "common_cause", argument_variables: ["x", "y"] }] } } };
    const unknown = assessUnknownCause(configured, { as_of: "2026-09-07T00:00:00.000Z" });
    expect(unknown.support.some((record) => record.claim === "supported")).toBe(true);
    const proposition = [...unknown.claim_propositions!.values()].find((item) => item.kind === "common_cause")!;
    expect(proposition.arguments).toEqual(["seed", "end"]);
    expect(unknown.support.find((record) => record.proposition_id === proposition.proposition_id)?.claim).toBe("unknown");
    const cause = { ...observed, predicate: "common_cause", assertionId: "causal-assertion",
      evidenceReceipts: [{ evidenceId: "e-cause", eventId: "event-cause", eventType: "relation.evidence", occurredAt: "2026-09-06T00:00:00.000Z" }] };
    const proven = assessUnknownCause({ ...configured, observed_relations: [observed, cause] }, { as_of: "2026-09-07T00:00:00.000Z" });
    expect(proven.support.find((record) => record.proposition_id === proposition.proposition_id)?.claim).toBe("supported");
  });
  it("retains duplicate assertions in either arrival and withdrawal order", () => {
    const rows = [edge("seed", "end", "a", "a1"), edge("seed", "end", "a", "a2")];
    for (const order of [rows, [...rows].reverse()]) {
      for (const removed of ["a1", "a2"]) {
        const revised = withdrawDerivationLeaves(field(rel("a"), order), removed);
        expect(grade(revised)).toBe(800);
        expect(grade(revised)).toBe(grade(field(rel("a"), order.filter((row) => row.assertionId !== removed))));
        expect(grade(withdrawDerivationLeaves(revised, removed === "a1" ? "a2" : "a1"))).toBe(0);
      }
    }
  });

  it("retains every serial premise leaf and equals fresh evaluation on withdrawal", () => {
    const program = and(seq(rel("a", "x", "m"), rel("b", "m", "y")), rel("c"));
    const rows = [edge("seed", "mid", "a"), edge("mid", "end", "b"), edge("seed", "end", "c")];
    const initial = field(program, rows);
    expect(grade(initial)).toBe(800);
    for (const removed of ["a", "b", "c"]) {
      expect(grade(withdrawDerivationLeaves(initial, removed))).toBe(0);
      expect(grade(withdrawDerivationLeaves(initial, removed))).toBe(grade(field(program, rows.filter((row) => row.assertionId !== removed))));
    }
  });

  it("nested alternatives are order invariant and preserve the weaker surviving route", () => {
    const rows = [edge("seed", "mid", "weak"), edge("seed", "mid", "strong"), edge("mid", "end", "tail"), edge("seed", "end", "c")];
    for (const choices of [["weak", "strong"], ["strong", "weak"]]) {
      const program = and(seq(alt(...choices.map((kind) => rel(kind, "x", "m"))), rel("tail", "m", "y")), rel("c"));
      const initial = field(program, rows);
      expect(grade(initial)).toBe(800);
      expect(grade(withdrawDerivationLeaves(initial, "strong"))).toBe(200);
      expect(grade(withdrawDerivationLeaves(initial, "weak"))).toBe(800);
    }
  });

  it("nested OR rewrite retains complete child closure and explicit root correspondence", () => {
    const leaves = ["a", "b", "c", "d"].map((id) => leafDerivation({ derivation_id: id, observation_id: id }));
    const branch = joinDerivation("or", leaves.slice(0, 3));
    const root = joinDerivation("and", [branch, leaves[3]!]);
    const next = reviseDerivations([...leaves, branch, root], "c");
    const forest = derivationForest(next.derivations);
    for (const node of next.derivations) for (const child of node.children) expect(forest.has(child)).toBe(true);
    expect(evaluateDerivation(forest, next.roots.get(root.derivation_id)!, new Map([["a", 200], ["b", 800], ["d", 900]]))).toBe(800);
  });

  it("explicit output roots recover assertion-named serial explanations without guessing object strings", () => {
    const state = field(rel("a"), [edge("seed", "end", "a", "opaque-assertion")]);
    const grounded = groundedOutputDerivations({ ...state, allowance: 100 });
    expect(grounded.complete).toBe(true);
    if (state.binding.kind !== "bound") throw new Error("field rejected");
    const index = projectAcceptingIndex({ snapshot: state.binding.snapshot, query_id: state.query_id, snapshot_id: state.snapshot_id,
      result_version: "1", view: defaultView(), budget: defaultBudget(), derivations: grounded.derivations, output_derivations: grounded.roots });
    const entry = index.entries.find((entry) => entry.object_id === "end")!;
    expect(entry.explanation_ids.length).toBeGreaterThan(0);
    const forest = new Map(index.explanations?.map((row) => [row.derivation_id, row]));
    for (const root of entry.explanation_ids) expect(forest.get(root)?.leaf_ids).toContain("opaque-assertion");
    for (const node of forest.values()) for (const child of node.children) expect(forest.has(child)).toBe(true);
  });

  it("product role and path identities retain long coordinates and independent routes", () => {
    const state = field(rel("a"), [edge("seed", "end", "a")]);
    if (state.binding.kind !== "bound") throw new Error("field rejected");
    const original = state.binding.snapshot.values.find((value) => value.accepting)!;
    const left = { ...original, state: { ...original.state, object_id: "x".repeat(180), binding_context: "y".repeat(180) } };
    const right = { ...left, state: { ...left.state, hypothesis_id: "h1" } };
    expect(composedFacetPathId(left.state, "weak")).not.toBe(composedFacetPathId(left.state, "strong"));
    expect(composedFacetPathId(left.state, "weak")).not.toBe(composedFacetPathId(right.state, "weak"));
    const index = projectAcceptingIndex({ snapshot: { ...state.binding.snapshot, values: [left, right], facets: [] }, query_id: state.query_id,
      snapshot_id: state.snapshot_id, result_version: "1", view: defaultView(), budget: defaultBudget(),
      roles: new Map([[productStateNodeId(left.state), "requested"], [productStateNodeId(right.state), "associated"]]) });
    expect(index.entries.map((entry) => entry.role).sort()).toEqual(["associated", "requested"]);
  });

  it("named guard needs positive evidence and retains absent versus false", () => {
    const guard = { schema_version: 1 as const, kind: "query_predicate" as const, verdict: "unresolved" as const,
      predicate_name: "proven_root_cause", variable: "x", time_scope: "none" as const };
    const env = new Map([["x", "seed"]]);
    expect(evaluateGuard(guard, env, new Map())).toBe("unresolved");
    expect(evaluateGuard(guard, env, new Map([["seed", { object_id: "seed", predicates: { proven_root_cause: false } }]]))).toBe("false");
    expect(evaluateGuard(guard, env, new Map([["seed", { object_id: "seed", predicates: { proven_root_cause: true } }]]))).toBe("true");
  });
});
