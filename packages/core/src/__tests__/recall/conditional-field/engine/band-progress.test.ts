import { describe, expect, it } from "vitest";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { FieldValueSchema, InformationIndexSchema, sharedProductIdentity, type QueryInterpretation, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { createConditionalField, type BindableState, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { bindChargedField, orderedProjectionValues } from "../../../../recall/conditional-field/engine/field-solve.js";
import { bindMaxMinField, productIndexOrderKey, productStateNodeId, type BindMaxMinSuccess } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { indexEntryRevision, resumeIndexProjection } from "../../../../recall/runtime/index-continuation.js";
import { projectAcceptingIndex, type AcceptingProjectionInput } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productComponentState } from "../../../../recall/conditional-field/index/product-component-diff.js";
import { bindEngineState } from "../../../../recall/conditional-field/engine/field-update.js";
import { snapshotRestoredEngineWork } from "../../../../recall/runtime/request-cost-engine-snapshot.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const interpretation: QueryInterpretation = { schema_version: 1, query_id: "band-progress", snapshot_id: SNAPSHOT_ID,
  status: "resolved", holes: [], hypotheses: [], view: defaultView(), program: { schema_version: 1, kind: "epsilon" } };
const seed = (id: string, grade = 1000, contract?: string): SeedActivation => ({ schema_version: 1,
  state: productKey(id), milligrades: grade, ...(contract === undefined ? {} : { cap_contract_id: contract }) });
const edge = (from: string, to: string, grade: number, contract?: string): Transition => ({ schema_version: 1,
  from: productKey(from), to: productKey(to), relation_kind: "related", strength_milligrades: grade, applicable: true,
  validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, ...(contract === undefined ? {} : { cap_contract_id: contract }) });

function input(seeds: readonly SeedActivation[], guaranteed: readonly SeedActivation[], work: number,
  transitions: readonly Transition[] = []): BindableState {
  const { binding: _binding, closure: _closure, identity_index: _identities, ordered_identities: _ordered, ...base } =
    createConditionalField({ interpretation, budget: defaultBudget() });
  return { ...base, seeds, guaranteed_seeds: guaranteed, transitions, guaranteed_transitions: transitions,
    remaining_exploration: work, remaining_reserve: 0, residuals: [] };
}

function bind(state: BindableState): BindMaxMinSuccess {
  const result = bindChargedField(state, []);
  expect(result.exploration).toBeGreaterThanOrEqual(0);
  expect(result.reserve).toBeGreaterThanOrEqual(0);
  expect(result.binding.kind).toBe("bound");
  if (result.binding.kind !== "bound") throw new Error("bound field expected");
  expect(result.binding.solver_steps).toBeLessThanOrEqual(state.remaining_exploration + state.remaining_reserve);
  return result.binding;
}

function project(bound: BindMaxMinSuccess, residuals: FieldEngineState["residuals"] = [], extra: Partial<AcceptingProjectionInput> = {}) {
  return InformationIndexSchema.parse(projectAcceptingIndex({ snapshot: bound.snapshot, query_id: bound.snapshot.query_id,
    snapshot_id: bound.snapshot.snapshot_id, result_version: "test", budget: defaultBudget(), view: defaultView(),
    observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: residuals }, ...extra }));
}

describe("finite budget service for guaranteed and possible fields", () => {
  it("finishes a known seed behind a thousand possible seeds and exposes it with an open upper bound", () => {
    const known = seed("known", 900);
    const seeds = [...Array.from({ length: 1000 }, (_, index) => seed(`possible-${index}`, 100)), known];
    const state = input(seeds, [known], 100);
    const bound = bind(state);
    const id = productStateNodeId(known.state);
    expect(bound.solver_steps).toBe(100);
    expect(bound.possible_complete).toBe(false);
    expect(bound.guaranteed_complete).toBe(true);
    expect(bound.values.has(id)).toBe(false);
    expect(bound.guaranteed_values?.get(id)).toBe(900);
    const expected = { activation: { kind: "reachable", milligrades: 900 }, low_milligrades: 900, high_milligrades: 1000 };
    expect(bound.snapshot.values.find((value) => productStateNodeId(value.state) === id)).toMatchObject(expected);
    const ordered = new PersistentStringMap<typeof known.state>().with(productIndexOrderKey(known.state), known.state);
    expect(orderedProjectionValues({ ...state, binding: bound, ordered_identities: ordered } as FieldEngineState)?.at(0)).toMatchObject(expected);
  });

  it("retains the next-band cursor across one-unit continuations without rescanning source rows", () => {
    let visits = 0;
    const seeds = new Proxy([seed("a"), seed("b"), seed("c")], { get(target, key, receiver) {
      if (key === Symbol.iterator) return () => { throw new Error("full source rescan"); };
      if (key === "at") return (index: number) => { visits += 1; return target.at(index); };
      return Reflect.get(target, key, receiver);
    } });
    const base = input(seeds, [seed("c")], 1);
    let bound = bind(base);
    expect(bound.next_band).toBe("guaranteed");
    expect(visits).toBe(1);
    bound = bind({ ...base, proven_binding: bound });
    expect(bound.next_band).toBe("possible");
    expect(bound.guaranteed_values?.get(productStateNodeId(productKey("c")))).toBe(1000);
    expect(visits).toBe(1);
    for (let round = 0; round < 20 && !bound.solver_complete; round += 1) bound = bind({ ...base, proven_binding: bound });
    expect(bound.solver_complete).toBe(true);
    expect(visits).toBe(3);
    expect(bound.values.size).toBe(3);
  });

  it.each([1, 2, 7, 31])("matches the independent full binder with %s-unit continuations across mixed contracts", (work) => {
    const contract = `sha256:${"a".repeat(64)}`;
    const seeds = [seed("a", 1000), seed("a", 400, contract)];
    const transitions = [edge("a", "hard", 900), edge("a", "soft", 800, contract), edge("soft", "end", 300, contract)];
    const base = input(seeds, seeds, work, transitions);
    const reference = bindMaxMinField({ query_id: base.query_id, snapshot_id: base.snapshot_id,
      budget: base.budget, seeds, transitions });
    if (reference.kind !== "bound") throw new Error("reference rejected");
    let bound = bind(base);
    for (let round = 0; round < 100 && !bound.solver_complete; round += 1) bound = bind({ ...base, proven_binding: bound });
    expect(bound.solver_complete).toBe(true);
    expect([...bound.values].sort()).toEqual([...reference.values].sort());
    expect([...bound.guaranteed_values!].sort()).toEqual([...reference.values].sort());
    expect(bound.values.get(productStateNodeId(productKey("hard")))).toBe(900);
    expect(bound.values.get(productStateNodeId(productKey("soft")))).toBe(400);
    expect(bound.values.get(productStateNodeId(productKey("end")))).toBe(300);
  });

  it("adds a disjoint contract without replaying the settled partitions", () => {
    const old = seed("old", 700);
    const base = input([old], [old], 100);
    const previous = bind(base);
    const fresh = seed("fresh", 300, `sha256:${"b".repeat(64)}`);
    const additions = { seeds: [fresh], transitions: [] };
    const next = bind({ ...base, seeds: [old, fresh], guaranteed_seeds: [old, fresh], proven_binding: previous,
      binding_delta: { possible: additions, guaranteed: additions } });
    expect(next.solver_complete).toBe(true);
    expect(next.solver_steps).toBe(4);
    expect(next.values.get(productStateNodeId(old.state))).toBe(700);
    expect(previous.values.has(productStateNodeId(fresh.state))).toBe(false);
  });

  it("does not revive a scalar after three incompatible activated contracts", () => {
    const seeds = ["a", "b", "c"].map((hex) => seed("same", 900, `sha256:${hex.repeat(64)}`));
    const bound = bind(input(seeds, seeds, 100));
    expect(bound.solver_complete).toBe(true);
    expect(bound.values.has(productStateNodeId(productKey("same")))).toBe(false);
    expect(bound.preparation?.values.conflicted(productStateNodeId(productKey("same")))).toBe(true);
  });

  it.each(["abc", "acb", "bac", "bca", "cab", "cba"].flatMap((order) => [1, 2, 7].map((work) => ({ order, work }))))(
    "keeps $order contract permutations incomparable with $work-unit continuations", ({ order, work }) => {
    const soft = [...order].map((hex, index) => seed("same", 200 + index * 100, `sha256:${hex.repeat(64)}`));
    const seeds = [seed("same", 1000), soft[0]!, ...soft, seed("same", 1000)];
    const base = input(seeds, seeds, work);
    let bound = bind(base);
    for (let round = 0; round < 40 && !bound.solver_complete; round += 1) bound = bind({ ...base, proven_binding: bound });
    const reference = bindMaxMinField({ query_id: base.query_id, snapshot_id: base.snapshot_id,
      budget: base.budget, seeds, transitions: [] });
    if (reference.kind !== "bound") throw new Error("reference rejected");
    // Three activated non-hard contracts have no shared numeric scale, regardless of duplicates or hard identity.
    for (const result of [bound, reference]) {
      expect(result.solver_complete).toBe(true);
      expect(result.snapshot.values).toHaveLength(1);
      const value = FieldValueSchema.parse(result.snapshot.values[0]);
      expect(value.activation).toEqual({ kind: "incomparable", reason: "cap_contract_conflict" });
      expect(value.milligrades).toBeUndefined();
      expect(value.low_milligrades).toBeUndefined();
      expect(value.high_milligrades).toBeUndefined();
      expect(FieldValueSchema.safeParse({ ...value, milligrades: 0 }).success).toBe(false);
      const index = project(result);
      expect(index.entries).toEqual([]);
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    }
    expect(bound.snapshot.values[0]?.activation).toEqual(reference.snapshot.values[0]?.activation);
  });

  it("does not combine an older guaranteed scalar with a newly conflicting possible activation", () => {
    const a = seed("same", 700, `sha256:${"a".repeat(64)}`);
    const b = seed("same", 400, `sha256:${"b".repeat(64)}`);
    const base = input([a], [a], 100);
    const previous = bind(base);
    const next = bind({ ...base, seeds: [a, b], remaining_exploration: 1, proven_binding: previous,
      binding_delta: { possible: { seeds: [b], transitions: [] }, guaranteed: { seeds: [], transitions: [] } } });
    expect(next.guaranteed_values?.get(productStateNodeId(a.state))).toBe(700);
    expect(next.possible_complete).toBe(false);
    expect(next.snapshot.values[0]?.activation).toEqual({ kind: "incomparable", reason: "cap_contract_conflict" });
    expect(next.snapshot.values[0]?.low_milligrades).toBeUndefined();
    expect(project(next).completeness.logical_index).not.toBe("complete");
    expect(previous.snapshot.values[0]?.milligrades).toBe(700);
    const oldEntry = project(previous).entries[0]!;
    const id = sharedProductIdentity(a.state);
    const updated = project(next, [], { delivered_entry_revisions: { [id]: indexEntryRevision(oldEntry) },
      delivered_product_states: { [id]: productComponentState(oldEntry) } });
    expect(updated.entries).toEqual([]);
    expect(updated.product_updates).toContainEqual(expect.objectContaining({ update_kind: "retraction" }));
    expect(updated.completeness.logical_index).not.toBe("complete");
  });

  it("detects incomparable scales first discovered separately by the two bands", () => {
    const a = seed("same", 700, `sha256:${"a".repeat(64)}`);
    const b = seed("same", 400, `sha256:${"b".repeat(64)}`);
    const bound = bind(input([a, b], [b], 2));
    expect(bound.preparation?.values.conflictCount).toBe(0);
    expect(bound.guaranteed_preparation?.values.conflictCount).toBe(0);
    expect(bound.cross_contract_conflicts?.count).toBe(1);
    expect(bound.snapshot.has_incomparable_activations).toBe(true);
    expect(bound.snapshot.values[0]?.activation).toEqual({ kind: "incomparable", reason: "cap_contract_conflict" });
    expect(project(bound).completeness.logical_index).not.toBe("complete");
  });

  it("keeps a guaranteed soft scale when only hard identity has been visited in possible", () => {
    const hard = seed("same", 1000);
    const soft = seed("same", 400, `sha256:${"a".repeat(64)}`);
    const bound = bind(input([hard, soft], [soft], 2));
    expect(bound.snapshot.values[0]).toMatchObject({ milligrades: 400, low_milligrades: 400,
      high_milligrades: 1000, cap_contract_id: soft.cap_contract_id });
  });

  it("removes conflict and its required residual when withdrawal rebuilds the activated contract set", () => {
    const a = seed("same", 700, `sha256:${"a".repeat(64)}`);
    const b = seed("same", 400, `sha256:${"b".repeat(64)}`);
    const conflicted = bindEngineState({ ...input([a, b], [a, b], 100), seen_identities: [a.state] });
    expect(conflicted.residuals.some((region) => region.region_id === "field.cap-contract-conflict")).toBe(true);
    const { binding: previous, closure: _closure, ...rest } = conflicted;
    const recovered = bindEngineState({ ...rest, seeds: [a], guaranteed_seeds: [a], retained_index: undefined,
      proven_binding: previous, remaining_exploration: 100,
      binding_delta: { reset: true, possible: { seeds: [a], transitions: [] }, guaranteed: { seeds: [a], transitions: [] } } });
    if (recovered.binding.kind !== "bound") throw new Error("recovery rejected");
    expect(recovered.binding.solver_complete).toBe(true);
    expect(recovered.binding.snapshot.has_incomparable_activations).toBe(false);
    expect(recovered.binding.snapshot.values[0]?.milligrades).toBe(700);
    expect(recovered.binding.snapshot.values[0]?.high_milligrades).toBe(700);
    expect(recovered.residuals.some((region) => region.region_id === "field.cap-contract-conflict")).toBe(false);
    expect(recovered.solver_retained_bytes).toBeGreaterThan(conflicted.solver_retained_bytes!);
    expect(project(recovered.binding, recovered.residuals).entries).toHaveLength(1);
  });

  it("gates allocation before admitting rows and resumes without losing the unadmitted input", () => {
    const base = input([seed("a")], [seed("a")], 100);
    const stopped = bindChargedField({ ...base, remaining_memory_bytes: 1 }, []);
    if (stopped.binding.kind !== "bound") throw new Error("control state rejected");
    expect(stopped.binding.solver_steps).toBe(0);
    expect(stopped.binding.solver_complete).toBe(false);
    expect(stopped.memory_exhausted).toBe(true);
    expect(stopped.remaining_memory_bytes).toBe(1);
    expect(stopped.solver_retained_bytes).toBe(0);
    expect(stopped.binding.preparation?.pending.length).toBe(0);
    expect(stopped.binding.preparation?.nodes.size).toBe(0);
    expect(stopped.binding.preparation?.deferred?.seeds).toBe(base.seeds);
    const recovered = bindChargedField({ ...base, proven_binding: stopped.binding }, []);
    expect(recovered.complete).toBe(true);
    expect(recovered.remaining_memory_bytes).toBeLessThan(base.remaining_memory_bytes);
    const meter = snapshotRestoredEngineWork({ ...base, solver_retained_bytes: recovered.solver_retained_bytes }, 1_000_000);
    expect(meter.remaining_memory_bytes).toBe(1_000_000 - recovered.solver_retained_bytes);
    // Retrying the old issued control state is immutable and incurs the same charge.
    const retry = bindChargedField({ ...base, proven_binding: stopped.binding }, []);
    expect(retry.solver_retained_bytes).toBe(recovered.solver_retained_bytes);
    expect(stopped.binding.preparation?.nodes.size).toBe(0);
  });

  it("serves a smaller guaranteed atom after possible admission cannot fit memory", () => {
    const known = seed("known", 900);
    const expensive = seed("\u0001".repeat(256), 100);
    const base = input([expensive, known], [known], 100);
    const result = bindChargedField({ ...base, remaining_memory_bytes: 8_500 }, []);
    if (result.binding.kind !== "bound") throw new Error("control state rejected");
    expect(result.binding.preparation?.nodes.size).toBe(0);
    expect(result.binding.guaranteed_complete).toBe(true);
    expect(result.binding.guaranteed_values?.get(productStateNodeId(known.state))).toBe(900);
    expect(result.memory_exhausted).toBe(true);
    expect(result.binding.snapshot.values.find((row) => row.milligrades === 900)?.high_milligrades).toBe(1000);
  });

  it("exposes and then clears resource residuals through the engine boundary", () => {
    const a = seed("a", 700);
    const base = input([a], [a], 100);
    const blocked = bindEngineState({ ...base, seen_identities: [a.state], remaining_memory_bytes: 1_000 });
    expect(blocked.memory_exhausted).toBe(true);
    expect(blocked.residuals).toContainEqual(expect.objectContaining({ region_id: "field.solver-memory", status: "interrupted" }));
    const { binding, closure: _closure, ...rest } = blocked;
    const recovered = bindEngineState({ ...rest, proven_binding: binding, remaining_exploration: 100,
      memory_exhausted: false, remaining_memory_bytes: 1_000_000 - (blocked.solver_retained_bytes ?? 0) });
    if (recovered.binding.kind !== "bound") throw new Error("recovery rejected");
    expect(recovered.binding.solver_complete).toBe(true);
    expect(recovered.residuals.some((region) => region.region_id === "field.solver-memory")).toBe(false);
    expect(recovered.binding.snapshot.values[0]).toMatchObject({ low_milligrades: 700, high_milligrades: 700 });
  });

  it("rebuilds only the full deferred band on successive same-contract enhancements", () => {
    const initial = seed("same", 200);
    const base = input([initial], [initial], 100);
    const previous = bind(base);
    const enhanced = seed("same", 500);
    const pending = bind({ ...base, seeds: [enhanced], remaining_exploration: 0, proven_binding: previous,
      binding_delta: { possible: { seeds: [enhanced], transitions: [] }, guaranteed: { seeds: [], transitions: [] } } });
    const latest = seed("same", 800);
    const rebuilt = bind({ ...base, seeds: [latest], remaining_exploration: 0, proven_binding: pending,
      binding_delta: { possible: { seeds: [latest], transitions: [] }, guaranteed: { seeds: [], transitions: [] } } });
    expect(rebuilt.preparation?.nodes.size).toBe(0);
    expect(rebuilt.guaranteed_preparation).toBe(previous.guaranteed_preparation);
    expect(rebuilt.solver_complete).toBe(false);
    const final = bind({ ...base, seeds: [latest], proven_binding: rebuilt });
    expect(final.solver_complete).toBe(true);
    expect(final.values.get(productStateNodeId(initial.state))).toBe(800);
    expect(final.guaranteed_values?.get(productStateNodeId(initial.state))).toBe(200);
  });

  it("restarts upper-bound projection when queues close without changing numeric values", () => {
    const base = input([seed("a", 700)], [seed("a", 700)], 2);
    const partial = bind(base);
    const state = { ...base, binding: partial } as FieldEngineState;
    const progress = resumeIndexProjection(state, partial.snapshot);
    const complete = bind({ ...base, remaining_exploration: 2, proven_binding: partial });
    expect(complete.solver_complete).toBe(true);
    expect(complete.values).toBe(partial.values);
    expect(complete.guaranteed_values).toBe(partial.guaranteed_values);
    const resumed = resumeIndexProjection({ ...state, binding: complete, projection_progress: { ...progress, offset: 1 } }, complete.snapshot);
    expect(resumed.offset).toBe(0);
    expect(resumed.generation).toBe(progress.generation + 1);
    expect(partial.snapshot.values[0]?.high_milligrades).toBe(1000);
    expect(complete.snapshot.values[0]?.high_milligrades).toBe(700);
  });

  it.each([100, 100_000])("projects a bounded ordered page of %s identities without materializing the snapshot", (size) => {
    const a = seed("a", 700);
    const bound = bind(input([a], [a], 100));
    const value = bound.snapshot.values[0]!;
    for (const summary of [false, undefined] as const) {
      let reads = 0;
      const index = projectAcceptingIndex({ query_id: interpretation.query_id, snapshot_id: SNAPSHOT_ID,
        result_version: "bounded", view: defaultView(), budget: defaultBudget({ page_budget: 1 }), remaining_reserve: 2,
        snapshot: { schema_version: 1, query_id: interpretation.query_id, snapshot_id: SNAPSHOT_ID,
          seeds: [], facets: [], retained_transitions: [], has_incomparable_activations: summary,
          get values(): readonly typeof value[] { throw new Error("unfunded full materialization"); } },
        ordered_values: { size, at: () => { reads += 1; return value; } },
        observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] } });
      expect(index.entries).toHaveLength(1);
      expect(reads).toBe(1);
      if (summary === undefined) expect(index.completeness.logical_index).not.toBe("complete");
    }
  });

  it("rebuilds a cross-band conflict summary when a full deferred band is replaced", () => {
    const a = seed("same", 700, `sha256:${"a".repeat(64)}`);
    const b = seed("same", 400, `sha256:${"b".repeat(64)}`);
    const base = input([a, b], [b], 2);
    const prior = bind(base);
    const pending = bind({ ...base, remaining_exploration: 0, proven_binding: prior,
      binding_delta: { possible: { seeds: [a], transitions: [] }, guaranteed: { seeds: [], transitions: [] } } });
    expect(pending.snapshot.has_incomparable_activations).toBe(true);
    const rebuilt = bind({ ...base, remaining_exploration: 0, proven_binding: pending,
      binding_delta: { possible: { seeds: [a], transitions: [] }, guaranteed: { seeds: [], transitions: [] } } });
    expect(rebuilt.cross_contract_conflicts?.count).toBe(0);
    expect(rebuilt.snapshot.has_incomparable_activations).toBe(false);
    expect(prior.snapshot.has_incomparable_activations).toBe(true);
    const resumed = bind({ ...base, proven_binding: rebuilt, remaining_exploration: 100 });
    expect(resumed.snapshot.has_incomparable_activations).toBe(true);
    expect(resumed.solver_complete).toBe(true);
  });
});
