import { expect, it, vi } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import * as observation from "../../../recall/runtime/conditional-field-observe.js";
import * as projection from "../../../recall/runtime/source-semantic-projection.js";
import { RequestCostLedger } from "../../../recall/runtime/request-cost-ledger.js";
import { SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { executeSemanticFixture } from "./source-semantic-proof-fixture.js";
import { coverageSelectionFixture, selectionExecutionBudget } from "./source-semantic-selection-fixture.js";

it("retains observation charges when the shared allowance cannot fund proof projection", () => {
  const complete = coverageSelectionFixture(selectionExecutionBudget).pool[0]!;
  const proof = complete.proofs[0]!;
  const ledgers = new Map<SourceSemanticResourceLedger, {
    id: number; initial_work: number; initial_bytes: number;
    phases: Map<string, { calls: number; work: number; bytes: number }>;
  }>();
  type Capacity = ReturnType<SourceSemanticResourceLedger["remaining"]>;
  const groups: unknown[] = [], failures: unknown[] = [];
  const projections: { query: string; before: Capacity; after: Capacity;
    failed?: boolean; error?: string; outcome?: unknown; bindings?: number; entries?: number }[] = [];
  const identify = (ledger: SourceSemanticResourceLedger) => {
    let value = ledgers.get(ledger);
    if (value === undefined) {
      value = { id: ledgers.size, initial_work: ledger.work, initial_bytes: ledger.bytes, phases: new Map() };
      ledgers.set(ledger, value);
    }
    return value;
  };
  const charge = SourceSemanticResourceLedger.prototype.charge;
  const charged = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
    const ledger = identify(this);
    try { charge.call(this, work, bytes, phase); }
    catch (error) {
      failures.push({ ledger: ledger.id, phase, work, bytes, remaining_work: this.work, remaining_bytes: this.bytes });
      throw error;
    }
    const previous = ledger.phases.get(phase) ?? { calls: 0, work: 0, bytes: 0 };
    ledger.phases.set(phase, { calls: previous.calls + 1, work: previous.work + work, bytes: previous.bytes + bytes });
  });
  const observeField = observation.observeField;
  const observed = vi.spyOn(observation, "observeField").mockImplementation((query, input) => {
    const cost = new RequestCostLedger();
    const state = observeField(query, { ...input, cost });
    groups.push({ query: query.query_id, before: input.budget,
      after: { work: state.remaining_exploration + state.remaining_reserve, memory: state.remaining_memory_bytes },
      closure: state.closure, seeds: state.seeds.length, states: state.seen_identities.length,
      transitions: state.transitions.length, cost: cost.snapshot() });
    return state;
  });
  const project = projection.projectSourceSemanticState;
  const projected = vi.spyOn(projection, "projectSourceSemanticState").mockImplementation(input => {
    const before = input.meter.remaining();
    const row = { query: input.query.query_id, before };
    try {
      const value = project(input);
      projections.push({ ...row, after: input.meter.remaining(), outcome: value.body.outcome,
        bindings: value.body.binding_results?.length ?? 0, entries: value.index?.entries.length ?? 0 });
      return value;
    } catch (error) {
      projections.push({ ...row, after: input.meter.remaining(), failed: true,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  try {
    // Observation progress is not proof progress: both phases spend the same allowance.
    const { executed } = executeSemanticFixture({ interpretation: proof.interpretation, semantics: proof.query,
      correspondence: proof.semantic_correspondence, original: proof.original_query,
      library: true, budget: { ...SOURCE_SEMANTIC_REASONING_BUDGET,
        work_units: 50_000 } });
    expect(groups.length).toBeGreaterThan(0);
    expect(projections).toHaveLength(1);
    const firstProjection = projections[0]!;
    expect(firstProjection).toMatchObject({ failed: true,
      error: "source semantic index projection allowance budget exhausted" });
    expect(firstProjection.before.work_units).toBeLessThan(
      SOURCE_SEMANTIC_REASONING_BUDGET.finalization_reserve + SOURCE_SEMANTIC_REASONING_BUDGET.min_envelope);
    expect(firstProjection.after).toEqual(firstProjection.before);
    const charges = [...ledgers].map(([ledger, value]) => {
      const phases = [...value.phases].map(([phase, delta]) => ({ phase, ...delta }));
      expect(phases.reduce((sum, row) => sum + row.work, 0)).toBe(ledger.spentWork);
      expect(phases.reduce((sum, row) => sum + row.bytes, 0)).toBe(ledger.spentBytes);
      return { id: value.id, initial_work: value.initial_work, initial_bytes: value.initial_bytes,
        spent_work: ledger.spentWork, spent_bytes: ledger.spentBytes, phases };
    });
    console.log(`SOURCE_OBSERVATION_COST ${JSON.stringify({ source_id: proof.interpretation.source.source_id,
      outcome: executed.result.outcome, resource_usage: executed.result.resource_usage,
      index_entries: executed.index?.entries.length ?? null, groups, projections, charges, failures })}`);
    expect(charges).toHaveLength(1);
    expect(executed.result.resource_usage).toEqual({
      work_units: charges[0]!.spent_work, memory_bytes: charges[0]!.spent_bytes });
    expect(executed.result.resource_usage!.work_units + firstProjection.before.work_units).toBe(50_000);
    expect(executed.result.resource_usage!.memory_bytes).toBeLessThanOrEqual(SOURCE_SEMANTIC_REASONING_BUDGET.memory_bytes);
    expect(executed.result.outcome).toEqual({ status: "resource_exhausted" });
    expect(executed.index).toBeNull();
    expect(executed.result.binding_results).toBeUndefined();
    expect(executed.source_dependencies).toBeUndefined();
    expect(charges[0]!.phases.some(row => row.phase === "engine" && row.work > 0)).toBe(true);
    expect(charges[0]!.phases.some(row => row.phase === "index projection")).toBe(false);
  } finally { projected.mockRestore(); observed.mockRestore(); charged.mockRestore(); }
}, 30_000);
