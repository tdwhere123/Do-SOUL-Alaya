import { describe, expect, it } from "vitest";
import type { SeedActivation, Transition } from "@do-soul/alaya-protocol";
import { createConditionalField, withdrawDerivationLeaves, type FieldEngineState } from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { traceDerivationForest, localLeafIds } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { seedActivationDerivationId } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { bindMaxMinField, productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { fieldPartitionNodeId, hardIdentityCapContractId, composeCapContracts } from "../../../../recall/conditional-field/cap-contract.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { defaultBudget, defaultView, productKey } from "../reference/deployment.fixture.js";
import { query, relation } from "./relation-grounding.fixture.js";

const HARD = hardIdentityCapContractId();
const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const budget = defaultBudget({ work_units: 100_000, memory_bytes: 16_000_000, finalization_reserve: 10_000 });
const seed = (object: string, milligrades: number, contract?: string): SeedActivation => ({ schema_version: 1,
  state: productKey(object), milligrades, ...(contract === undefined ? {} : { cap_contract_id: contract }) });
const edge = (from: string, to: string, grade: number, contract?: string): Transition => ({ schema_version: 1,
  from: productKey(from), to: productKey(to), relation_kind: `${from}-${to}`, instance_id: `${from}-${to}`,
  strength_milligrades: grade, applicable: true, validity: { kind: "query_snapshot", as_of: "2026-09-10T00:00:00.000Z" },
  ...(contract === undefined ? {} : { cap_contract_id: contract }) });
const build = (seeds: readonly SeedActivation[], transitions: readonly Transition[]) => createConditionalField({
  interpretation: query(relation("p")), seeds, transitions, budget, residuals: [] });
function bound(state: FieldEngineState) {
  if (state.binding.kind !== "bound") throw new Error("expected bound field");
  expect(state.binding.solver_complete).toBe(true);
  return state.binding;
}
function proof(state: FieldEngineState, object: string, contract?: string) {
  const result = groundedOutputDerivations({ ...state, allowance: 100_000 });
  expect(result.complete).toBe(true);
  const roots = result.roots[fieldPartitionNodeId(productStateNodeId(productKey(object)), contract)] ?? [];
  return { result, roots, leaves: [...localLeafIds(traceDerivationForest({
    forest: new Map(result.derivations.map(row => [row.derivation_id, row])), roots }).traversal)].sort() };
}

describe("finite input contract coordinates (not production Soft relation admission)", () => {
  it.each([
    { label: "Hard only", initial: HARD, start: 1000, transfer: HARD, cap: 1000, expected: 1000, output: HARD },
    { label: "Soft only", initial: A, start: 700, transfer: A, cap: 500, expected: 500, output: A },
    { label: "Soft then Hard", initial: A, start: 700, transfer: HARD, cap: 1000, expected: 700, output: A },
    { label: "Hard then Soft", initial: HARD, start: 1000, transfer: A, cap: 500, expected: 500, output: A },
    { label: "reachable Soft zero", initial: A, start: 0, transfer: HARD, cap: 1000, expected: 0, output: A },
    { label: "untagged then Hard", initial: undefined, start: 300, transfer: HARD, cap: 1000, expected: 300, output: undefined }
  ])("$label preserves its coordinate, bounds, and original proof leaves", ({ initial, start, transfer, cap, expected, output }) => {
    const first = seed("start", start, initial), transition = edge("start", "end", cap, transfer);
    const field = build([first], [transition]);
    const value = bound(field).snapshot.values.find(row => row.state.target.kind === "memory_entry" && row.state.target.object_id === "end");
    expect(value).toMatchObject({ activation: { kind: "reachable", milligrades: expected }, low_milligrades: expected, high_milligrades: expected });
    expect(value?.cap_contract_id).toBe(output);
    const grounded = proof(field, "end", output);
    expect(grounded.leaves).toContain(seedActivationDerivationId(first));
    expect(grounded.leaves).toContain("start-end");
    const index = projectAcceptingIndex({ snapshot: bound(field).snapshot, query_id: field.query_id, snapshot_id: field.snapshot_id,
      result_version: "coordinate-test", view: defaultView(), budget, derivations: grounded.result.derivations,
      output_derivations: grounded.result.roots, grounding_complete: true });
    expect(index.entries.find(row => row.object_id === "end")).toMatchObject({ association_milligrades: expected,
      explanation_ids: grounded.roots });
  });

  it.each([[A, B], [undefined, A]] as const)("does not serially convert %s into %s", (initial, transfer) => {
    const field = build([seed("start", 700, initial)], [edge("start", "end", 500, transfer)]);
    expect(bound(field).snapshot.values.find(row => row.state.target.kind === "memory_entry" && row.state.target.object_id === "end")?.activation)
      .toEqual({ kind: "unreachable" });
    expect(proof(field, "end", transfer).roots).toEqual([]);
  });

  it.each([false, true])("retains both Soft alternatives independently of arrival order (reverse=%s)", reverse => {
    const seeds = [seed("same", 700, A), seed("same", 300, B)];
    if (reverse) seeds.reverse();
    const field = build(seeds, [edge("same", "end", 1000, HARD)]);
    expect(field.seeds).toHaveLength(2);
    const binding = bound(field);
    expect(binding.snapshot.values.every(row => row.activation?.kind === "incomparable")).toBe(true);
    for (const [contract, grade] of [[A, 700], [B, 300]] as const) {
      expect(binding.preparation?.numericValues.get(fieldPartitionNodeId(productStateNodeId(productKey("end")), contract))).toBe(grade);
      expect(proof(field, "end", contract).leaves).toContain(seedActivationDerivationId(seed("same", grade, contract)));
    }
  });

  it("selects an independent Hard proof without comparing two optional Soft routes, retaining both histories", () => {
    const hard = seed("same", 1000, HARD), a = seed("same", 700, A), b = seed("same", 300, B);
    const field = build([a, hard, b], [edge("same", "end", 1000, HARD)]);
    const binding = bound(field), grounded = proof(field, "end", HARD);
    const value = binding.snapshot.values.find(row => row.state.target.kind === "memory_entry" && row.state.target.object_id === "end");
    expect(value).toMatchObject({ milligrades: 1000, low_milligrades: 1000, high_milligrades: 1000, cap_contract_id: HARD });
    expect(binding.snapshot.has_incomparable_activations).toBe(false);
    expect(grounded.leaves).toEqual([seedActivationDerivationId(hard), "same-end"].sort());
    expect(proof(field, "end", A).leaves).toContain(seedActivationDerivationId(a));
    expect(proof(field, "end", B).leaves).toContain(seedActivationDerivationId(b));
    const index = projectAcceptingIndex({ snapshot: binding.snapshot, query_id: field.query_id, snapshot_id: field.snapshot_id,
      result_version: "coordinate-test", view: defaultView(), budget, derivations: grounded.result.derivations,
      output_derivations: grounded.result.roots, grounding_complete: true });
    expect(index.entries.find(row => row.object_id === "end")?.explanation_ids).toEqual(grounded.roots);
    const withdrawn = withdrawDerivationLeaves(field, seedActivationDerivationId(hard));
    expect(bound(withdrawn).snapshot.values.every(row => row.activation?.kind === "incomparable")).toBe(true);
  });

  it("Hard OR Soft is top in that coordinate; withdrawing Hard restores the Soft proof and value", () => {
    const hard = seed("same", 1000, HARD), soft = seed("same", 400, A);
    const transitions = [edge("same", "end", 1000, HARD)];
    const field = build([hard, soft], transitions);
    expect(bound(field).values.get(productStateNodeId(productKey("end")))).toBe(1000);
    expect(proof(field, "end", A).leaves).toEqual([seedActivationDerivationId(hard), seedActivationDerivationId(soft), "same-end"].sort());
    const withdrawn = withdrawDerivationLeaves(field, seedActivationDerivationId(hard));
    const fresh = build([soft], transitions);
    expect(bound(withdrawn).snapshot.values).toEqual(bound(fresh).snapshot.values);
    expect(proof(withdrawn, "end", A).leaves).toEqual(proof(fresh, "end", A).leaves);
    expect(bound(withdrawn).values.get(productStateNodeId(productKey("end")))).toBe(400);
    expect(bound(build([hard, soft], transitions)).values.get(productStateNodeId(productKey("end")))).toBe(1000);
  });

  it("resumes each Hard lift atom and grounding step without changing full recomputation", () => {
    const seeds = [seed("s", 600, A), seed("h", 1000, HARD)];
    const transitions = [edge("s", "end", 1000, HARD), edge("h", "end", 1000, HARD)];
    const input = { query_id: "coordinates", snapshot_id: query(relation("p")).snapshot_id, budget, seeds, transitions };
    let result = bindMaxMinField({ ...input, incremental: { additions: { seeds, transitions } }, work_limit: 1 });
    for (let turn = 0; turn < 100 && result.kind === "bound" && !result.solver_complete; turn++) {
      result = bindMaxMinField({ ...input, incremental: { prior: result.preparation, additions: { seeds: [], transitions: [] } }, work_limit: 1 });
    }
    const field = build(seeds, transitions);
    expect(result.kind === "bound" && [...result.values].sort()).toEqual([...bound(field).values].sort());
    const full = proof(field, "end", A).result;
    let progress: typeof full.progress | undefined;
    let paged = full;
    for (let turn = 0; turn < full.work + 10; turn++) {
      paged = groundedOutputDerivations({ ...field, allowance: 1, progress });
      progress = paged.progress;
      if (paged.complete) break;
    }
    expect(paged.complete).toBe(true);
    expect(paged.roots).toEqual(full.roots);
    expect(paged.progress.grades.get(fieldPartitionNodeId(productStateNodeId(productKey("end")), A))).toBe(1000);
  });

  it.each(["Hard", "Soft"] as const)("adds a late %s coordinate through single-atom continuations", late => {
    const hard = seed("start", 1000, HARD), soft = seed("start", 400, A);
    const old = late === "Hard" ? soft : hard, added = late === "Hard" ? hard : soft;
    const transitions = [edge("start", "end", 1000, HARD)];
    const input = { query_id: "late-coordinate", snapshot_id: query(relation("p")).snapshot_id, budget, transitions };
    const initial = bindMaxMinField({ ...input, seeds: [old], incremental: { additions: { seeds: [old], transitions } } });
    if (initial.kind !== "bound") throw new Error("initial field rejected");
    let result = bindMaxMinField({ ...input, seeds: [old, added], work_limit: 1,
      incremental: { prior: initial.preparation, additions: { seeds: [added], transitions: [] } } });
    for (let turn = 0; turn < 100 && result.kind === "bound" && !result.solver_complete; turn++) {
      result = bindMaxMinField({ ...input, seeds: [old, added], work_limit: 1,
        incremental: { prior: result.preparation, additions: { seeds: [], transitions: [] } } });
    }
    if (result.kind !== "bound") throw new Error("resumed field rejected");
    expect(result.solver_complete).toBe(true);
    const end = productStateNodeId(productKey("end"));
    expect(result.preparation?.numericValues.get(fieldPartitionNodeId(end, A))).toBe(1000);
    expect(initial.preparation?.numericValues.get(fieldPartitionNodeId(end, A))).toBe(late === "Hard" ? 400 : undefined);
    const fresh = bound(build([old, added], transitions));
    expect([...result.preparation!.numericValues].sort()).toEqual([...fresh.preparation!.numericValues].sort());
  });

  it("rejects a non-Boolean value explicitly labeled Hard, without treating untagged zero as absence", () => {
    expect(() => build([seed("bad", 400, HARD)], [])).toThrow("Hard identity is Boolean");
    expect(bound(build([seed("zero", 0)], [])).snapshot.values[0]).toMatchObject({ milligrades: 0, low_milligrades: 0 });
  });

  it("AND contract composition is order independent and never joins distinct Soft coordinates", () => {
    expect(composeCapContracts([HARD, A])).toEqual({ kind: "compatible", contract: A });
    expect(composeCapContracts([A, HARD])).toEqual({ kind: "compatible", contract: A });
    expect(composeCapContracts([A, B, HARD])).toEqual({ kind: "incomparable" });
  });
});
