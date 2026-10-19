import { describe, expect, it } from "vitest";
import { summarizeObservationCosts } from "../../../runs/longmemeval-semantic/observation-costs.js";
import type { ObservationCallScope, ObservationCapturedFrame } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";

const call: ObservationCallScope = { kind: "recall", request_id: 9, session_id: "session", query_key: "q",
  snapshot_id: `sha256:${"ab".repeat(32)}`, workspace_id: "ws", as_of: "2026-10-20T00:00:00Z" };
const cost = (phase: string, reason: string, operation: string, work: number, bytes: number) =>
  ({ phase, reason, operation, count: 1, work, bytes });
const native = (overrides: Partial<SourceSemanticNativeFacts> = {}): SourceSemanticNativeFacts => ({
  binding: { session_id: "session", request_id: 9, operation: "recall", workspace_id: "ws", as_of: call.as_of,
    snapshot_revision: "1:0", preparation: null, index: null }, pool: null, lease_reads: [], lease_issues: [],
  operations: [], encodings: [], complete: true, issues: [], ...overrides });
const frame = (overrides: Partial<SourceSemanticObservation> = {}): SourceSemanticObservation => ({
  version: 1, request_id: 9, status: "observed", execution: "success", events: [], facts: native(),
  costs: [cost("request", "request admission", "debit", 3, 10),
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
      held: { work_units: 0, memory_bytes: 0 } }],
  totals: { debit_work: 7, debit_bytes: 30, absorb_work: 4, absorb_bytes: 20 }, dropped_events: 0,
  aggregates_complete: true, overhead: { capture_ms: 2, event_json_bytes: 12, ipc_bytes: null, ipc_time: "not_measured",
    physical_peak_memory: "not_measured", physical_sql_work: "not_measured" }, issues: [], ...overrides });
const captured = (observation = frame(), scope = call): ObservationCapturedFrame => ({ call: scope, observation });
const summarize = (overrides: Partial<SourceSemanticObservation> = {}) => summarizeObservationCosts({ scope: call,
  frames: [captured(frame(overrides))] });

describe("observation costs", () => {
  it("distinguishes unavailable totals, positive independent lower bounds and complete ledger amounts", () => {
    const missing = summarizeObservationCosts({ scope: call, frames: [] });
    expect(missing.spent).toEqual({ state: "unavailable", work: null, bytes: null, rows: 0 });
    expect(missing.classification.status).toBe("unavailable");
    expect(summarize({ status: "unavailable", totals: null, costs: [], meters: [], aggregates_complete: false }).spent)
      .toEqual({ state: "unavailable", work: null, bytes: null, rows: 0 });
    const partial = summarize({ status: "partial", totals: null, aggregates_complete: false });
    expect(partial.spent).toEqual({ state: "lower_bound", work: 7, bytes: 30, rows: 2 });
    expect(partial.observation.complete).toBe(false);
    const independent = summarize({ costs: [], meters: [], status: "partial", aggregates_complete: false,
      totals: { debit_work: 11, debit_bytes: 23, absorb_work: 0, absorb_bytes: 0 } });
    expect(independent.spent).toEqual({ state: "lower_bound", work: 11, bytes: 23, rows: 0 });
    expect(independent.accounting_validity).toBe("invalid");
    expect(independent.complete).toBe(false);
  });

  it("keeps contradictory complete counters unavailable, not a manufactured maximum or lower bound", () => {
    const result = summarize({ totals: { debit_work: 8, debit_bytes: 31, absorb_work: 4, absorb_bytes: 20 } });
    expect(result.observation.complete).toBe(true);
    expect(result.accounting_validity).toBe("invalid");
    expect(result.spent).toEqual({ state: "unavailable", work: null, bytes: null, rows: 2 });
    expect(result.conservation).toMatchObject({ root_meter_spent_work: 7, totals_debit_work: 8 });
    expect(result.unknown).toContain("debit_total_mismatch");
    expect(result.complete).toBe(false);
  });

  it("conserves debits exactly and does not count native labels, absorption, holds or allocations as spending", () => {
    const result = summarize();
    expect(result.spent).toEqual({ state: "known", work: 7, bytes: 30, rows: 2 });
    expect(result.decomposition).toEqual({ debit_work: 7, debit_bytes: 30, conserved: true });
    expect(result.classified.reduce((sum, row) => sum + (row.work ?? 0), 0)).toBe(7);
    expect(result.classified.find(row => row.class === "real_native_read"))
      .toEqual({ class: "real_native_read", state: "known", work: 4, bytes: 20, rows: 1 });
    expect(result.classified.find(row => row.class === "duplicate_operation_label")?.work).toBe(0);
    expect(result.mapped_rows.find(row => row.operation === "native_read")?.class).toBe("duplicate_operation_label");
    expect(result.transfers.absorbed).toEqual({ state: "known", work: 4, bytes: 20, rows: 1 });
    expect(result.transfers.holds).toEqual({ state: "known", work: 8, bytes: 80, rows: 1 });
    expect(result.transfers.allocations).toEqual({ state: "known", work: 100, bytes: 1000, rows: 1 });
    expect(result.conservation).toMatchObject({ debits_match_totals: true, root_meters_match_debits: true,
      child_spent_work: 4, absorbed_matches_child_spent: true, unexplained_debit_work: 0,
      child_and_parent_unused_not_summed: true });
    expect(result.overhead).toMatchObject({ ipc_bytes: null, physical_sql_work: "not_measured", diagnostic_only: true });
  });

  it("reports parent/child unused capacity and current future holds per meter without a global unused sum", () => {
    const base = frame();
    const result = summarize({ costs: [...base.costs, cost("request", "request unused", "unused", 93, 970)],
      meters: base.meters.map(meter => meter.parent === null ? meter : { ...meter, held: { work_units: 2, memory_bytes: 10 } }) });
    expect(result.transfers.unused_allowance).toEqual({ state: "unavailable", work: null, bytes: null, rows: 2 });
    expect(result.allowances.aggregation).toBe("per_meter_only");
    expect(result.allowances.unused_rows.map(row => row.work)).toEqual([46, 93]);
    expect(result.allowances.meters.map(row => [row.remaining.work_units, row.held.work_units])).toEqual([[93, 0], [46, 2]]);
    expect(result.spent.work).toBe(7);
  });

  it("annotates same-object retention/scans and exact native encoding repetitions without adding or declaring waste", () => {
    const operations: SourceSemanticNativeFacts["operations"] = [
      { kind: "retain", meter_id: 1, phase: "request", reason: "retained pool", count: 2, work: 6, bytes: 60,
        completed: 2, same_object_count: 1, same_object_work: 3, same_object_bytes: 30 },
      { kind: "canonical_scan", meter_id: 1, phase: "request", reason: "canonical JSON size scan", count: 2, work: 4, bytes: 0,
        completed: 1, same_object_count: 1, same_object_work: 1, same_object_bytes: 0 }];
    const encodings: SourceSemanticNativeFacts["encodings"] = [
      { phase: "selection", purpose: "candidate_page", encoder_invocations: 3, count: 2, utf8_bytes: 200,
        identical_complete_encodings: 0, repeated_component_bytes: 60, compared_components: 4 },
      { phase: "final_delivery", purpose: "base_page", encoder_invocations: 1, count: 1, utf8_bytes: 100,
        identical_complete_encodings: 1, repeated_component_bytes: 30, compared_components: 2 }];
    const rows = [cost("request", "retained pool", "debit", 6, 60),
      cost("request", "canonical size traversal", "debit", 2, 0), cost("request", "canonical size string scan", "debit", 2, 0),
      cost("selection", "candidate delivery bytes", "debit", 2, 400),
      cost("request", "library public serialization", "debit", 1, 100)];
    const result = summarize({ costs: rows, meters: [], facts: native({ operations, encodings }),
      totals: { debit_work: 13, debit_bytes: 560, absorb_work: 0, absorb_bytes: 0 } });
    expect(result.spent).toEqual({ state: "known", work: 13, bytes: 560, rows: 5 });
    expect(result.decomposition).toEqual({ debit_work: 13, debit_bytes: 560, conserved: true });
    expect(result.mapped_rows.map(row => row.class)).toEqual(["retention_proxy", "canonical_scan_proxy", "canonical_scan_proxy",
      "selection_encoding", "final_encoding"]);
    expect(result.native_annotations).toMatchObject({ status: "complete", additional_debits: false, repeated_work_waste: "not_established",
      operations: [{ same_object_work: 3, same_object_bytes: 30, debit_row_positions: [0], matches_recorded_debits: true },
        { completed: 1, same_object_work: 1, debit_row_positions: [1, 2], matches_recorded_debits: true }], encodings });
    const historical = summarize({ facts: undefined });
    expect(historical.native_annotations.status).toBe("unavailable");
    const partial = summarize({ facts: native({ operations, encodings, complete: false, issues: ["encoding_identity_limit"] }) });
    expect(partial.native_annotations.status).toBe("partial");
    expect(partial.native_annotations.encodings[0]?.identical_complete_encodings).toBe(0);
    expect(partial.native_annotations.operations[0]?.matches_recorded_debits).toBe(false);
  });

  it("preserves unclassified debits and distinguishes final encoding from final-delivery phase labels", () => {
    const rows = [cost("request", "library public serialization", "debit", 1, 20),
      cost("selection", "candidate partial delivery bytes", "debit", 2, 30),
      cost("final_delivery", "access verified source extent", "debit", 3, 0),
      cost("final_delivery", "optional source time semantic capture", "debit", 4, 40),
      cost("final_delivery", "unrecognized operation", "debit", 5, 50),
      cost("final_delivery", "library index eligibility check", "debit", 1, 0)];
    const result = summarize({ costs: rows, meters: [], totals: { debit_work: 16, debit_bytes: 140, absorb_work: 0, absorb_bytes: 0 } });
    expect(result.mapped_rows.map(row => row.class)).toEqual(["final_encoding", "selection_encoding", "real_native_read",
      "unclassified", "unclassified", "unclassified"]);
    expect(result.decomposition.conserved).toBe(true);
    expect(result.classification.status).toBe("partial");
    expect(result.complete).toBe(false);
  });

  it("distinguishes a complete zero-cost ledger from missing cost evidence", () => {
    const result = summarize({ costs: [], totals: { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 }, meters: [{
      id: 1, parent: null, phase: "request", initial: { work_units: 100, memory_bytes: 1000 },
      remaining: { work_units: 100, memory_bytes: 1000 }, spent: { work_units: 0, memory_bytes: 0 }, held: { work_units: 0, memory_bytes: 0 } }] });
    expect(result.spent).toEqual({ state: "known", work: 0, bytes: 0, rows: 0 });
    expect(result.classification.status).toBe("complete");
    expect(result.accounting_validity).toBe("valid");
    expect(result.complete).toBe(true);
  });

  it("selects only the exact call, even when an ancestor or another session has the same request number", () => {
    const foreignCall = { ...call, session_id: "foreign" };
    const foreign = frame({ facts: native({ binding: { ...native().binding!, session_id: "foreign" } }) });
    const result = summarizeObservationCosts({ scope: call, frames: [captured(), captured(foreign, foreignCall)] });
    expect(result.spent.work).toBe(7);
    const missing = summarizeObservationCosts({ scope: call, frames: [captured(foreign, foreignCall)] });
    expect(missing.spent.work).toBeNull();
    expect(missing.unknown).toContain("observation_missing_for_request");
    const conflict = summarize({ facts: native({ binding: { ...native().binding!, session_id: "foreign" } }) });
    expect(conflict.spent.work).toBeNull();
    expect(conflict.unknown).toContain("native_call_binding_mismatch");
  });
});
