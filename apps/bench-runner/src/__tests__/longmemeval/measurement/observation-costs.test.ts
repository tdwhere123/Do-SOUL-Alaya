import { describe, expect, it } from "vitest";
import { summarizeObservationCosts } from "../../../runs/longmemeval-semantic/observation-costs.js";
import type { ObservationCallScope } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";

const call: ObservationCallScope = { kind: "recall", request_id: 9, query_key: "q", snapshot_id: "snap",
  index_generation: "generation" };
const cost = (phase: string, reason: string, operation: string, work: number, bytes: number) =>
  ({ phase, reason, operation, count: 1, work, bytes });
const frame = (overrides: Partial<SourceSemanticObservation> = {}): SourceSemanticObservation => ({
  version: 1, request_id: 9, status: "observed", execution: "success",
  events: [], costs: [cost("request", "request admission", "debit", 3, 10),
    cost("observation", "native source read", "debit", 4, 20),
    cost("observation", "native source read", "native_read", 4, 20),
    cost("request", "observation", "absorb", 4, 20),
    cost("observation", "phase remainder at absorption", "unused", 46, 480),
    cost("request", "phase allowance", "allocation", 100, 1000),
    cost("observation", "source completion allowance", "hold", 8, 80),
    cost("observation", "source completion allowance", "release", 8, 80),
    cost("observation", "capacity only", "refused", 99, 999)],
  meters: [
    { id: 1, parent: null, phase: "request", initial: { work_units: 100, memory_bytes: 1000 },
      remaining: { work_units: 93, memory_bytes: 970 }, spent: { work_units: 7, memory_bytes: 30 },
      held: { work_units: 0, memory_bytes: 0 } },
    { id: 2, parent: 1, phase: "observation", initial: { work_units: 50, memory_bytes: 500 },
      remaining: { work_units: 46, memory_bytes: 480 }, spent: { work_units: 4, memory_bytes: 20 },
      held: { work_units: 0, memory_bytes: 0 } }
  ],
  totals: { debit_work: 7, debit_bytes: 30, absorb_work: 4, absorb_bytes: 20 }, dropped_events: 0,
  aggregates_complete: true,
  overhead: { capture_ms: 2, event_json_bytes: 12, ipc_bytes: null, ipc_time: "not_measured",
    physical_peak_memory: "not_measured", physical_sql_work: "not_measured" }, issues: [],
  ...overrides
});

describe("observation costs", () => {
  it("separates unavailable totals, positive lower bounds and complete known ledger amounts", () => {
    const missing = summarizeObservationCosts({ scope: call, observations: [] });
    expect(missing.spent).toEqual({ state: "unavailable", work: null, bytes: null, rows: 0 });
    expect(missing.classification.status).toBe("unavailable");
    const unavailable = summarizeObservationCosts({ scope: call, observations: [frame({
      status: "unavailable", totals: null, costs: [], meters: [], aggregates_complete: false
    })] });
    expect(unavailable.spent).toEqual({ state: "unavailable", work: null, bytes: null, rows: 0 });
    const partial = summarizeObservationCosts({ scope: call, observations: [frame({
      status: "partial", totals: null, aggregates_complete: false
    })] });
    expect(partial.spent).toEqual({ state: "lower_bound", work: 7, bytes: 30, rows: 2 });
    expect(partial.observation.complete).toBe(false);
  });

  it("preserves positive independent counter lower bounds when detailed debit rows are absent", () => {
    const result = summarizeObservationCosts({ scope: call, observations: [frame({
      costs: [], meters: [], status: "partial", aggregates_complete: false,
      totals: { debit_work: 11, debit_bytes: 23, absorb_work: 0, absorb_bytes: 0 }
    })] });
    expect(result.spent).toEqual({ state: "lower_bound", work: 11, bytes: 23, rows: 0 });
    expect(result.accounting_validity).toBe("invalid");
    expect(result.complete).toBe(false);
  });

  it("does not report accounting mismatches as unqualified complete observations", () => {
    const result = summarizeObservationCosts({ scope: call, observations: [frame({
      totals: { debit_work: 8, debit_bytes: 31, absorb_work: 4, absorb_bytes: 20 }
    })] });
    expect(result.observation.complete).toBe(true);
    expect(result.accounting_validity).toBe("invalid");
    expect(result.complete).toBe(false);
    expect(result.unknown).toContain("debit_total_mismatch");
  });

  it("maps actual final encoding reasons instead of all final-delivery phase spending", () => {
    const rows = [cost("request", "library public serialization", "debit", 1, 20),
      cost("selection", "candidate partial delivery bytes", "debit", 2, 30),
      cost("final_delivery", "access verified source extent", "debit", 3, 0),
      cost("final_delivery", "optional source time semantic capture", "debit", 4, 40),
      cost("final_delivery", "unrecognized operation", "debit", 5, 50),
      cost("final_delivery", "library index eligibility check", "debit", 1, 0)];
    const result = summarizeObservationCosts({ scope: call, observations: [frame({ costs: rows, meters: [],
      totals: { debit_work: 16, debit_bytes: 140, absorb_work: 0, absorb_bytes: 0 }
    })] });
    expect(result.mapped_rows.map(row => row.class)).toEqual(["final_encoding", "selection_encoding",
      "real_native_read", "unclassified", "unclassified", "unclassified"]);
    expect(result.classification.status).toBe("partial");
    expect(result.complete).toBe(false);
  });
  it("counts debit rows once and keeps absorption and unused allowance out of spent work", () => {
    const result = summarizeObservationCosts({ scope: call, observations: [frame()] });
    expect(result.spent).toEqual({ state: "known", work: 7, bytes: 30, rows: 2 });
    expect(result.transfers.absorbed).toEqual({ state: "known", work: 4, bytes: 20, rows: 1 });
    expect(result.transfers.unused_allowance).toEqual({ state: "known", work: 46, bytes: 480, rows: 1 });
    expect(result.transfers.allocations).toEqual({ state: "known", work: 100, bytes: 1000, rows: 1 });
    expect(result.classified.find(row => row.class === "real_native_read")).toEqual({ class: "real_native_read",
      state: "known", work: 4, bytes: 20, rows: 1 });
    expect(result.classified.find(row => row.class === "duplicate_operation_label")).toEqual({
      class: "duplicate_operation_label", state: "known", work: 4, bytes: 20, rows: 1 });
    expect(result.mapped_rows.find(row => row.reason === "request admission")?.class).toBe("unclassified");
    expect(result.mapped_rows.find(row => row.operation === "absorb")?.class).toBe("absorption_transfer");
    expect(result.conservation).toMatchObject({ debits_match_totals: true, root_meters_match_debits: true,
      child_spent_work: 4, absorbed_matches_child_spent: true, unexplained_debit_work: 0,
      child_and_parent_unused_not_summed: true });
    expect(result.observation.complete).toBe(true);
    expect(result.accounting_validity).toBe("valid");
    expect(result.classification.status).toBe("partial");
    expect(result.complete).toBe(false);
    expect(result.overhead).toMatchObject({ ipc_bytes: null, physical_sql_work: "not_measured", diagnostic_only: true });
  });

  it("keeps missing or partial observations unknown instead of inventing zero cost", () => {
    const missing = summarizeObservationCosts({ scope: call, observations: [] });
    expect(missing.spent).toEqual({ state: "unavailable", work: null, bytes: null, rows: 0 });
    expect(missing.conservation.debits_match_totals).toBeNull();
    expect(missing.unknown).toContain("observation_missing_for_request");
    expect(missing.complete).toBe(false);
    const partial = summarizeObservationCosts({ scope: call, observations: [frame({ status: "partial",
      totals: null, aggregates_complete: false, issues: ["worker_partial"] })] });
    expect(partial.conservation.totals_debit_work).toBeNull();
    expect(partial.unknown).toEqual(expect.arrayContaining(["totals_unavailable", "aggregates_incomplete", "worker_partial"]));
    expect(partial.complete).toBe(false);
  });

  it("distinguishes a complete zero-cost ledger from missing cost evidence", () => {
    const result = summarizeObservationCosts({ scope: call, observations: [frame({ costs: [],
      totals: { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 }, meters: [{
        id: 1, parent: null, phase: "request", initial: { work_units: 100, memory_bytes: 1000 },
        remaining: { work_units: 100, memory_bytes: 1000 }, spent: { work_units: 0, memory_bytes: 0 },
        held: { work_units: 0, memory_bytes: 0 } }]
    })] });
    expect(result.spent).toEqual({ state: "known", work: 0, bytes: 0, rows: 0 });
    expect(result.classification.status).toBe("complete");
    expect(result.accounting_validity).toBe("valid");
    expect(result.complete).toBe(true);
  });

  it("does not mix another request's frame into the selected call scope", () => {
    const result = summarizeObservationCosts({ scope: call, observations: [frame({ request_id: 10 })] });
    expect(result.observation.request_id).toBeNull();
    expect(result.spent.rows).toBe(0);
    expect(result.unknown).toContain("observation_missing_for_request");
  });
});
