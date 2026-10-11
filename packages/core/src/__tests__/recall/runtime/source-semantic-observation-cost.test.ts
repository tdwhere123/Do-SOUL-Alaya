import { expect, it, vi } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import * as observation from "../../../recall/runtime/conditional-field-observe.js";
import * as projection from "../../../recall/runtime/source-semantic-projection.js";
import { RequestCostLedger } from "../../../recall/runtime/request-cost-ledger.js";
import { deliveredProofFixture } from "./source-semantic-proof-fixture.js";
import { coverageSelectionFixture, executedInputNumbers, selectionExecutionBudget, sourcePrefixExhaustionBudget } from "./source-semantic-selection-fixture.js";

it("attributes bounded observation cost while retaining its source-supported input prefix", () => {
  const complete = coverageSelectionFixture(selectionExecutionBudget).pool[0]!;
  const proof = complete.proofs[0]!;
  const ledgers = new Map<SourceSemanticResourceLedger, {
    id: number; initial_work: number; initial_bytes: number;
    phases: Map<string, { calls: number; work: number; bytes: number }>;
  }>();
  const groups: unknown[] = [], projections: unknown[] = [], failures: unknown[] = [];
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
      projections.push({ ...row, after: input.meter.remaining(), failed: true });
      throw error;
    }
  });
  try {
    const actual = deliveredProofFixture({ interpretation: proof.interpretation, semantics: proof.query,
      correspondence: proof.semantic_correspondence, original: proof.original_query,
      library: true, budget: sourcePrefixExhaustionBudget });
    expect(groups.length).toBeGreaterThan(0);
    expect(projections.length).toBeGreaterThan(0);
    const charges = [...ledgers].map(([ledger, value]) => {
      const phases = [...value.phases].map(([phase, delta]) => ({ phase, ...delta }));
      expect(phases.reduce((sum, row) => sum + row.work, 0)).toBe(ledger.spentWork);
      expect(phases.reduce((sum, row) => sum + row.bytes, 0)).toBe(ledger.spentBytes);
      return { id: value.id, initial_work: value.initial_work, initial_bytes: value.initial_bytes,
        spent_work: ledger.spentWork, spent_bytes: ledger.spentBytes, phases };
    });
    console.log(`SOURCE_OBSERVATION_COST ${JSON.stringify({ source_id: proof.interpretation.source.source_id,
      outcome: actual.proof.outcome, resource_usage: actual.proof.resource_usage, groups, projections, charges, failures })}`);
    expect(actual.proof.outcome).toEqual({ status: "resource_exhausted" });
    expect(actual.proof.completeness).toMatchObject({ logical_index: "partial", observed_coverage: "open" });
    const executed = executedInputNumbers({ ...complete, proofs: [actual.proof] });
    expect(executed.length).toBeGreaterThanOrEqual(4);
    expect(executed.length).toBeLessThan(7);
    expect(executed).toEqual([1, 2, 3, 4, 5, 6, 7].slice(0, executed.length));
  } finally { projected.mockRestore(); observed.mockRestore(); charged.mockRestore(); }
  // Coverage must not put this fixture back on the production allowance, which now finishes the prefix.
}, 30_000);
