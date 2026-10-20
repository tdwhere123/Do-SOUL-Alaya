import { describe, expect, it } from "vitest";
import { summarizeObservationCosts } from "../../../runs/longmemeval-semantic/observation-costs.js";
import type { ObservationCallScope, ObservationCapturedFrame } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import { SourceSemanticObserver, readSourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import { SourceSemanticReadBudget } from "../../../../../core-daemon/src/runtime/field/source-semantic-read-stores.js";

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
type AllowanceWitnessRow = NonNullable<SourceSemanticObservation["meter_allowances"]>["rows"][number];

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
      "retention_proxy", "unclassified", "unclassified"]);
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

  it("reconciles real child spending and absorption beyond the meter sample without self-certifying transfers", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
    for (let index = 1; index <= 40; index++) {
      const child = root.child({ work_units: 100, memory_bytes: 1000 }, "completion_planning");
      child.charge(index, index * 2, "child work"); root.absorb(child);
    }
    const observed = observer.finish("success");
    expect(observed.meters).toHaveLength(32);
    expect(observed.aggregates_complete).toBe(true);
    expect(observed.meter_totals).toEqual({ complete: true, roots: 1, children: 40,
      root_spent: { work_units: 820, memory_bytes: 1640 }, child_spent: { work_units: 820, memory_bytes: 1640 } });
    expect(readSourceSemanticObservation(observed, 9)).toEqual(observed);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observed)] });
    expect(result.spent).toMatchObject({ state: "known", work: 820, bytes: 1640 });
    expect(result.accounting_validity).toBe("valid");
    expect(result.conservation.absorbed_matches_child_spent).toBe(true);
    // Forge both transfer rows and their independent transfer counters consistently.
    // Native child debits, root spend and debit counters remain unchanged.
    const forged = { ...observed, costs: observed.costs.map(row => row.operation === "absorb" ? { ...row, work: row.work + 1 } : row),
      totals: { ...observed.totals!, absorb_work: 821 } };
    const contradiction = summarizeObservationCosts({ scope: call, frames: [captured(forged)] });
    expect(contradiction.conservation.absorbed_matches_totals).toBe(true);
    expect(contradiction.conservation.absorbed_matches_child_spent).toBe(false);
    expect(contradiction.accounting_validity).toBe("invalid");
    expect(contradiction.spent.state).toBe("unavailable");
    const historical = { ...observed, meter_totals: undefined, aggregates_complete: false };
    const raw = JSON.stringify(historical);
    const old = summarizeObservationCosts({ scope: call, frames: [captured(historical)] });
    expect(old.conservation.child_spent_work).toBeNull();
    expect(old.conservation.absorbed_matches_child_spent).toBeNull();
    expect(old.accounting_validity).toBe("unavailable");
    expect(old.spent.state).toBe("lower_bound");
    expect(JSON.stringify(historical)).toBe(raw);
    const contradictoryRoot = { ...historical, meters: historical.meters.map(meter => meter.parent !== null ? meter : {
      ...meter, spent: { ...meter.spent, work_units: meter.spent.work_units + 1 },
      remaining: { ...meter.remaining, work_units: meter.remaining.work_units - 1 }
    }) };
    expect(summarizeObservationCosts({ scope: call, frames: [captured(contradictoryRoot)] }).accounting_validity).toBe("invalid");
  });

  it("detects an unabsorbed uncaptured child and preserves nested inclusive child spend", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
    for (let index = 0; index < 32; index++) root.child({ work_units: 100, memory_bytes: 1000 }, "empty");
    const child = root.child({ work_units: 100, memory_bytes: 1000 }, "observation");
    const grandchild = child.child({ work_units: 20, memory_bytes: 200 }, "nested");
    grandchild.charge(3, 30); child.absorb(grandchild); child.charge(2, 20);
    const missing = summarizeObservationCosts({ scope: call, frames: [captured(observer.finish("success"))] });
    expect(missing.accounting_validity).toBe("invalid");
    expect(missing.conservation).toMatchObject({ child_spent_work: 8, absorbed_matches_child_spent: false });
    root.absorb(child);
    const complete = summarizeObservationCosts({ scope: call, frames: [captured(observer.finish("success"))] });
    expect(complete.accounting_validity).toBe("valid");
    expect(complete.conservation).toMatchObject({ root_meter_spent_work: 5, child_spent_work: 8,
      absorbed_matches_child_spent: true });
  });

  it("keeps real constraint/promotion effects distinct from initial limits, holds and spent", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 32, max_bytes: 10000 });
    const root = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, observer);
    const child = root.child({ work_units: 80, memory_bytes: 800 }, "observation");
    const parentRelease = root.hold({ work_units: 50, memory_bytes: 500 });
    child.charge(4, 40);
    const childRelease = child.hold({ work_units: 6, memory_bytes: 60 });
    child.constrainToParent(root);
    expect(child.remaining()).toEqual({ work_units: 40, memory_bytes: 400 });
    parentRelease();
    const outstanding = child.outstandingAllowance();
    child.promoteAfterCensus({ work_units: root.work - outstanding.work_units, memory_bytes: root.bytes - outstanding.memory_bytes });
    const adjusted = observer.finish("success");
    expect(adjusted.meters[1]).toMatchObject({ initial: { work_units: 80, memory_bytes: 800 },
      capacity: { current: { work_units: 100, memory_bytes: 1000 }, adjustment: { work_units: 20, memory_bytes: 200 }, changes: 2 },
      remaining: { work_units: 90, memory_bytes: 900 }, spent: { work_units: 4, memory_bytes: 40 },
      held: { work_units: 6, memory_bytes: 60 } });
    expect(adjusted.costs).toContainEqual(cost("observation", "parent constraint", "capacity_decrease", 30, 300));
    expect(adjusted.costs).toContainEqual(cost("observation", "empty census promotion", "capacity_increase", 50, 500));
    childRelease(); root.absorb(child);
    const frame = observer.finish("success");
    const result = summarizeObservationCosts({ scope: call, frames: [captured(frame)] });
    expect(result.accounting_validity).toBe("valid");
    expect(result.spent).toMatchObject({ state: "known", work: 4, bytes: 40 });
    const forged = { ...frame, meters: frame.meters.map(meter => meter.parent === null ? meter : { ...meter,
      capacity: { ...meter.capacity!, adjustment: { work_units: 21, memory_bytes: 200 } } }) };
    expect(summarizeObservationCosts({ scope: call, frames: [captured(forged)] }).accounting_validity).toBe("invalid");
  });

  it("rejects root balance and complete aggregate contradictions even with capped child details", () => {
    const base = frame();
    const badRoot = summarize({ meters: base.meters.map(meter => meter.parent === null
      ? { ...meter, remaining: { ...meter.remaining, work_units: 94 } } : meter) });
    expect(badRoot.accounting_validity).toBe("invalid");
    expect(badRoot.conservation.root_balances_match).toBe(false);
    const badAggregate = summarize({ meter_totals: { complete: true, roots: 1, children: 1,
      root_spent: { work_units: 7, memory_bytes: 30 }, child_spent: { work_units: 3, memory_bytes: 20 } } });
    expect(badAggregate.accounting_validity).toBe("invalid");
    expect(badAggregate.conservation.meter_aggregate_matches_sample).toBe(false);
  });

  it("passes complete operation totals through even when sampled identities cannot reconcile a cost row", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
    const shared = { text: "same bytes" };
    for (let index = 0; index < 140; index++) {
      const child = root.child({ work_units: 100, memory_bytes: 1000 }, "planning");
      child.retain(shared, "retained pool"); root.absorb(child);
    }
    const failed = root.child({ work_units: 1, memory_bytes: 1000 }, "planning");
    expect(() => failed.retain(shared, "retained pool")).toThrow(); root.absorb(failed);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observer.finish("success"))] });
    expect(result.native_annotations.status).toBe("partial");
    expect(result.native_annotations.operations).toHaveLength(128);
    expect(result.native_annotations.operations.every(row => row.matches_recorded_debits === null)).toBe(true);
    expect(result.native_annotations.operation_totals).toMatchObject({ complete: true, rows: [
      { kind: "retain", count: 141, completed: 140, work: 281, bytes: 23624, same_object_count: 140, identity_capture: "complete" }] });
    expect(result.accounting_validity).toBe("valid");
  });

  it("maps only owner-proven computations, proxies, canonical identity and provenance costs", () => {
    const reasons = ["access text normalization and scoring", "access query features", "library page root census",
      "evidence selection candidates", "evidence coverage comparison", "evidence coverage exchange", "preparation lease",
      "retained value measurement work", "canonical identity traversal", "canonical identity hash handoff",
      "access trace selection", "library source window encoding", "mystery encoding", "mystery allocation"];
    const rows = reasons.map(reason => cost("request", reason, "debit", 1, 2));
    const result = summarize({ costs: rows, meters: [], totals: { debit_work: reasons.length, debit_bytes: reasons.length * 2,
      absorb_work: 0, absorb_bytes: 0 } });
    expect(result.mapped_rows.map(row => row.class)).toEqual(["real_computation", "computation_proxy", "real_computation",
      "real_computation", "real_computation", "real_computation", "retention_proxy", "retention_proxy", "canonical_identity",
      "canonical_identity", "telemetry", "encoding_proxy", "unclassified", "unclassified"]);
    expect(result.decomposition.conserved).toBe(true);
    expect(result.native_annotations.repeated_work_waste).toBe("not_established");
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

  it("classifies owner-traced phase, identity and selection reasons and keeps an unregistered reason unknown", () => {
    const rows = [
      cost("selection", "library pair source search", "debit", 7, 0),
      cost("selection", "final proof candidates", "debit", 2, 16),
      cost("selection", "returned tuple coverage", "debit", 3, 0),
      cost("request", "access source record lookup", "debit", 4, 64),
      cost("observation", "access observed source check", "debit", 5, 0),
      cost("request", "access final source signal reconciliation", "debit", 6, 0),
      cost("request", "source phase canonical native equality", "debit", 32, 0),
      cost("completion_planning", "source phase acquisition resource slots", "debit", 5, 0),
      cost("empty_completion_planning", "canonical identity hash handoff quotation", "debit", 8, 0),
      cost("request", "canonical prepared opcode block", "debit", 9, 72),
      cost("empty_completion_planning", "canonical prepared root matching", "debit", 10, 0),
      cost("request", "canonical prepared root matching", "debit", 10, 0),
      cost("request", "source phase canonical request bridge", "debit", 1, 16),
      cost("request", "source access identity frames", "debit", 11, 128),
      cost("request", "source phase canonical capture eligibility", "debit", 2, 0),
      cost("request", "source phase acquisition packing capture", "debit", 12, 96),
      cost("request", "source phase local index lookup", "debit", 13, 0),
      cost("request", "source phase execution tuple allocation", "debit", 1, 24),
      cost("request", "preparation lease retention accounting", "debit", 14, 0),
      cost("request", "access reconciled interpretation signals", "debit", 15, 120),
      cost("request", "source phase observation tuple allocation", "debit", 1, 24),
      cost("request", "worker query vector buffer references", "debit", 1, 80),
      cost("request", "empty interpretation completion planning", "debit", 1, 64),
      cost("request", "source union preparation completion planning", "debit", 1, 64),
      cost("request", "unregistered allocation", "debit", 9, 90)];
    const result = summarize({ costs: rows, meters: [], totals: {
      debit_work: 183, debit_bytes: 858, absorb_work: 0, absorb_bytes: 0 } });
    expect(result.mapped_rows.map(row => row.class)).toEqual(["real_computation", "real_computation",
      "real_computation", "real_computation", "real_computation", "real_computation", "real_computation",
      "real_computation", "canonical_identity", "canonical_identity", "canonical_identity", "canonical_identity",
      "canonical_identity", "canonical_identity", "canonical_identity", "encoding_proxy", "encoding_proxy",
      "encoding_proxy", "retention_proxy", "retention_proxy", "retention_proxy", "retention_proxy",
      "retention_proxy", "retention_proxy", "unclassified"]);
    expect(result.classification).toEqual({ status: "partial", classified_debit_rows: 24, total_debit_rows: 25 });
    expect(result.classified.find(row => row.class === "unclassified"))
      .toEqual({ class: "unclassified", state: "known", work: 9, bytes: 90, rows: 1 });
    expect(result.decomposition).toEqual({ debit_work: 183, debit_bytes: 858, conserved: true });
    expect(result.complete).toBe(false);
    expect(result.unknown).toContain("unclassified_cost_rows");
  });

  it("sums every classified debit exactly once without adding physical or repeated-work claims", () => {
    const rows = [
      cost("request", "canonical prepared scalar block", "debit", 10, 1096),
      cost("request", "source phase local index entry", "debit", 3, 48),
      cost("request", "access source record lookup", "debit", 4, 64),
      cost("selection", "library pair source search", "debit", 7, 0),
      cost("request", "preparation lease retention accounting", "debit", 5, 0),
      cost("request", "source phase observation expansion", "debit", 2, 14)];
    const result = summarize({ costs: rows, meters: [{
      id: 1, parent: null, phase: "request", initial: { work_units: 100, memory_bytes: 2000 },
      remaining: { work_units: 69, memory_bytes: 778 }, spent: { work_units: 31, memory_bytes: 1222 },
      held: { work_units: 0, memory_bytes: 0 } }], totals: {
      debit_work: 31, debit_bytes: 1222, absorb_work: 0, absorb_bytes: 0 } });
    expect(result.classification).toEqual({ status: "complete", classified_debit_rows: 6, total_debit_rows: 6 });
    expect(result.complete).toBe(true);
    expect(result.spent).toEqual({ state: "known", work: 31, bytes: 1222, rows: 6 });
    expect(result.mapped_rows.filter(row => row.operation === "debit")).toHaveLength(6);
    expect(result.classified.reduce((total, row) => total + (row.work ?? 0), 0)).toBe(31);
    expect(result.classified.reduce((total, row) => total + (row.bytes ?? 0), 0)).toBe(1222);
    expect(result.decomposition).toEqual({ debit_work: 31, debit_bytes: 1222, conserved: true });
    expect(result.native_annotations).toMatchObject({ additional_debits: false, repeated_work_waste: "not_established" });
    expect(result.overhead).toMatchObject({ ipc_bytes: null, ipc_time: "not_measured",
      physical_peak_memory: "not_measured", physical_sql_work: "not_measured", diagnostic_only: true });
    expect(result.unknown).toContain("physical_sql_work_not_measured");
    expect(result.unknown).not.toContain("unclassified_cost_rows");
  });

  it("keeps complete sibling allowance groups beyond the 32-meter detail sample", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10_000 }, observer);
    for (let index = 0; index < 40; index++) {
      const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
      const release = child.hold({ work_units: 2, memory_bytes: 20 });
      child.charge(1, 10, "actual work");
      if (index % 2 === 0) release();
      root.absorb(child);
    }
    const observed = observer.finish("success");
    expect(observed.meters).toHaveLength(32);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observed)] });
    const scoped = result.allowances.scoped;
    expect(scoped).toMatchObject({ status: "complete", scope: "parent_phase_siblings", state: "final",
      omitted_meters: 0, rows_match_meter_totals: true });
    expect(scoped.rows).toHaveLength(2);
    expect(scoped.rows[0]).toMatchObject({ parent: null, phase: "request", meters: 1,
      spent: { work_units: 40, memory_bytes: 400 }, remaining: { work_units: 960, memory_bytes: 9600 },
      capacity: { work_units: 1000, memory_bytes: 10_000 }, balanced: true });
    expect(scoped.rows[1]).toMatchObject({ parent: 1, phase: "observation", meters: 40,
      initial: { work_units: 400, memory_bytes: 4000 }, spent: { work_units: 40, memory_bytes: 400 },
      held: { work_units: 40, memory_bytes: 400 }, remaining: { work_units: 320, memory_bytes: 3200 },
      capacity: { work_units: 400, memory_bytes: 4000 }, adjustment: { work_units: 0, memory_bytes: 0 },
      capacity_changes: 0, balanced: true });
    // The capped sample holds 31 of the 40 sibling meters, so only the root group is fully comparable.
    expect(scoped.rows_match_sample).toBeNull();
    expect(result.conservation.child_spent_work).toBe(40);
    expect(result.accounting_validity).toBe("valid");
    expect(result.unknown).not.toContain("allowance_scope_unavailable");
  });

  it("rejects a partial sample that contradicts provable nonnegative allowance subtotals", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10_000 }, observer);
    for (let index = 0; index < 40; index++) {
      const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
      child.charge(1, 10, "actual work"); root.absorb(child);
    }
    const observed = observer.finish("success");
    expect(observed.meters).toHaveLength(32);
    const sampledChildren = observed.meters.filter(meter => meter.parent !== null);
    expect(sampledChildren.reduce((total, meter) => total + meter.initial.work_units, 0)).toBe(310);
    expect(sampledChildren.reduce((total, meter) => total + meter.remaining.work_units, 0)).toBe(279);
    const witness = observed.meter_allowances!;
    const rows: AllowanceWitnessRow[] = witness.rows.map(row => structuredClone(row));
    const childRow = rows[1]!;
    expect(childRow).toMatchObject({ parent: 1, phase: "observation", meters: 40,
      initial: { work_units: 400, memory_bytes: 4000 }, remaining: { work_units: 360, memory_bytes: 3600 },
      spent: { work_units: 40, memory_bytes: 400 }, held: { work_units: 0, memory_bytes: 0 },
      capacity: { current: { work_units: 400, memory_bytes: 4000 },
        adjustment: { work_units: 0, memory_bytes: 0 }, changes: 0 } });
    // The forged row still balances and its spend matches the complete meter counters, but the
    // 31 sampled siblings alone prove initial >= 310 and remaining >= 279; 40 and 0 contradict them.
    childRow.initial.work_units = 40; childRow.capacity.current.work_units = 40;
    childRow.spent.work_units = 40; childRow.remaining.work_units = 0;
    childRow.held.work_units = 0; childRow.capacity.adjustment.work_units = 0;
    const forged = summarizeObservationCosts({ scope: call, frames: [captured({ ...observed,
      meter_allowances: { ...witness, rows } })] });
    expect(forged.allowances.scoped.rows[1]!.balanced).toBe(true);
    expect(forged.allowances.scoped.rows_match_meter_totals).toBe(true);
    expect(forged.allowances.scoped.rows_match_sample).toBe(false);
    expect(forged.allowances.scoped.status).toBe("invalid");
    expect(forged.accounting_validity).toBe("invalid");
    expect(forged.spent.state).toBe("unavailable");
  });

  it("keeps a partial sample valid when unsampled siblings cancel sampled capacity adjustments", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10_000 }, observer);
    for (let index = 0; index < 40; index++) {
      const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
      child.promoteAfterCensus(index < 31
        ? { work_units: 15, memory_bytes: 150 } : { work_units: 4, memory_bytes: 40 });
      root.absorb(child);
    }
    const observed = observer.finish("success");
    expect(observed.meters).toHaveLength(32);
    const sampledAdjustment = observed.meters.filter(meter => meter.parent !== null)
      .reduce((total, meter) => total + (meter.capacity?.adjustment.work_units ?? 0), 0);
    expect(sampledAdjustment).toBe(155);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observed)] });
    const scoped = result.allowances.scoped;
    expect(scoped).toMatchObject({ status: "complete", rows_match_sample: null, rows_match_meter_totals: true });
    // The sampled 31 children hold +155/+1550 of signed adjustment while the full group holds
    // +101/+1010, so adjustment is not a lower bound; every nonnegative subtotal still fits.
    expect(scoped.rows[1]).toMatchObject({ meters: 40,
      initial: { work_units: 400, memory_bytes: 4000 },
      adjustment: { work_units: 101, memory_bytes: 1010 },
      capacity: { work_units: 501, memory_bytes: 5010 },
      remaining: { work_units: 501, memory_bytes: 5010 },
      spent: { work_units: 0, memory_bytes: 0 }, held: { work_units: 0, memory_bytes: 0 } });
    expect(result.accounting_validity).toBe("valid");
    expect(result.spent).toMatchObject({ state: "known", work: 0, bytes: 0 });
  });

  it("distinguishes held, adjusted and remaining capacity from absorption-time unused labels", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, observer);
    const child = root.child({ work_units: 80, memory_bytes: 800 }, "observation");
    const nested = child.child({ work_units: 20, memory_bytes: 200 }, "nested");
    child.hold({ work_units: 6, memory_bytes: 60 });
    child.charge(4, 40);
    nested.charge(1, 10);
    child.absorb(nested);
    child.promoteAfterCensus({ work_units: 50, memory_bytes: 500 });
    root.absorb(child);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observer.finish("success"))] });
    const scoped = result.allowances.scoped;
    expect(scoped).toMatchObject({ status: "complete", rows_match_sample: true, rows_match_meter_totals: true });
    expect(scoped.rows[1]).toMatchObject({ parent: 1, phase: "observation", meters: 1,
      initial: { work_units: 80, memory_bytes: 800 }, adjustment: { work_units: -19, memory_bytes: -190 },
      capacity: { work_units: 61, memory_bytes: 610 }, spent: { work_units: 5, memory_bytes: 50 },
      held: { work_units: 6, memory_bytes: 60 }, remaining: { work_units: 50, memory_bytes: 500 },
      capacity_changes: 1, balanced: true });
    expect(scoped.rows[2]).toMatchObject({ parent: 2, phase: "nested", meters: 1,
      spent: { work_units: 1, memory_bytes: 10 }, remaining: { work_units: 19, memory_bytes: 190 },
      balanced: true });
    expect(scoped.rows[1]!.held.work_units).not.toBe(scoped.rows[1]!.remaining.work_units);
    // The raw unused transfers stay per-absorption labels with no global sum.
    expect(result.allowances.unused_rows.map(row => [row.phase, row.work])).toEqual([["nested", 19], ["observation", 50]]);
    expect(result.transfers.unused_allowance).toEqual({ state: "unavailable", work: null, bytes: null, rows: 2 });
    expect(result.accounting_validity).toBe("valid");
  });

  it("keeps missing, omitted and failed allowance witnesses unknown instead of zero", () => {
    const historical = summarize();
    expect(historical.allowances.scoped).toMatchObject({ status: "unavailable", rows: [], omitted_meters: null,
      rows_match_sample: null, rows_match_meter_totals: null });
    expect(historical.unknown).toContain("allowance_scope_unavailable");
    expect(historical.accounting_validity).toBe("valid");
    expect(historical.spent).toMatchObject({ state: "known", work: 7 });
    const partialObserver = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, partialObserver);
    // Distinct grandchild parents exhaust the 128 allowance groups without overflowing cost reasons.
    for (let index = 0; index < 140; index++) {
      const child = root.child({ work_units: 10, memory_bytes: 100 }, "exploration");
      const nested = child.child({ work_units: 4, memory_bytes: 40 }, "observation");
      nested.charge(1, 10); child.absorb(nested); root.absorb(child);
    }
    const partial = summarizeObservationCosts({ scope: call, frames: [captured(partialObserver.finish("success"))] });
    expect(partial.allowances.scoped).toMatchObject({ status: "partial", omitted_meters: 14,
      rows_match_meter_totals: null });
    expect(partial.allowances.scoped.rows).toHaveLength(128);
    expect(partial.allowances.scoped.rows.every(row => row.balanced)).toBe(true);
    expect(partial.unknown).toEqual(expect.arrayContaining(["allowance_scope_incomplete", "meter_allowance_limit"]));
    // Complete debit and spend counters survive omitted allowance groups.
    expect(partial.spent).toMatchObject({ state: "known", work: 140, bytes: 1400 });
    const brokenObserver = new SourceSemanticObserver(9, { max_events: 1, max_bytes: 1000 });
    new SourceSemanticReadBudget({ work_units: 10, memory_bytes: 100 }, brokenObserver);
    brokenObserver.event("broken", "test", () => { throw new Error("capture failure"); });
    const broken = summarizeObservationCosts({ scope: call, frames: [captured(brokenObserver.finish("success"))] });
    expect(broken.allowances.scoped).toMatchObject({ status: "partial", omitted_meters: 0 });
    expect(broken.allowances.scoped.rows).toHaveLength(1);
  });

  it("rejects unbalanced, over-complete and sample-mismatched allowance rows", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 10_000, memory_bytes: 100_000 }, observer);
    for (let index = 0; index < 40; index++) {
      const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
      child.charge(1, 10); root.absorb(child);
    }
    const observed = observer.finish("success");
    const forge = (mutate: (rows: AllowanceWitnessRow[]) => void) => {
      const witness = observed.meter_allowances!;
      const rows: AllowanceWitnessRow[] = witness.rows.map(row => structuredClone(row));
      mutate(rows);
      return summarizeObservationCosts({ scope: call, frames: [captured({ ...observed,
        meter_allowances: { ...witness, rows } })] });
    };
    const unbalanced = forge(rows => { rows[1]!.remaining.work_units += 1; });
    expect(unbalanced.allowances.scoped.status).toBe("invalid");
    expect(unbalanced.accounting_validity).toBe("invalid");
    expect(unbalanced.spent.state).toBe("unavailable");
    expect(unbalanced.unknown).toContain("allowance_rows_contradictory");
    const retotaled = forge(rows => { rows[1]!.spent.work_units -= 1; rows[1]!.held.work_units += 1; });
    expect(retotaled.allowances.scoped.rows[1]!.balanced).toBe(true);
    expect(retotaled.allowances.scoped.rows_match_meter_totals).toBe(false);
    expect(retotaled.allowances.scoped.status).toBe("invalid");
    expect(retotaled.unknown).toContain("allowance_meter_total_mismatch");
    const claimed = summarizeObservationCosts({ scope: call, frames: [captured({ ...observed,
      meter_allowances: { ...observed.meter_allowances!, omitted_meters: 1 } })] });
    expect(claimed.allowances.scoped.status).toBe("invalid");
    expect(claimed.accounting_validity).toBe("invalid");
    expect(claimed.spent.state).toBe("unavailable");
    expect(claimed.unknown).toContain("allowance_rows_contradictory");
    const sampleObserver = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const sampleRoot = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, sampleObserver);
    const sampled = sampleRoot.child({ work_units: 10, memory_bytes: 100 }, "observation");
    const release = sampled.hold({ work_units: 4, memory_bytes: 40 });
    sampled.charge(1, 10); release(); sampleRoot.absorb(sampled);
    const sampleFrame = sampleObserver.finish("success");
    const sampleRows: AllowanceWitnessRow[] = sampleFrame.meter_allowances!.rows.map(row => structuredClone(row));
    sampleRows[1]!.spent.work_units -= 1; sampleRows[1]!.held.work_units += 1;
    const mismatch = summarizeObservationCosts({ scope: call, frames: [captured({ ...sampleFrame,
      meter_allowances: { ...sampleFrame.meter_allowances!, rows: sampleRows } })] });
    expect(mismatch.allowances.scoped.rows[1]!.balanced).toBe(true);
    expect(mismatch.allowances.scoped.rows_match_sample).toBe(false);
    expect(mismatch.allowances.scoped.status).toBe("invalid");
    expect(mismatch.unknown).toContain("allowance_sample_mismatch");
  });

  it("rejects duplicate, missing and split-misattributed complete allowance groups despite matching totals", () => {
    const build = (phases: readonly string[]) => {
      const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
      const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10_000 }, observer);
      for (const phase of phases) {
        const child = root.child({ work_units: 10, memory_bytes: 100 }, phase);
        child.charge(1, 10, "work");
        root.absorb(child);
      }
      return observer.finish("success");
    };
    const resummarize = (observed: SourceSemanticObservation, rows: AllowanceWitnessRow[]) =>
      summarizeObservationCosts({ scope: call, frames: [captured({ ...observed,
        meter_allowances: { ...observed.meter_allowances!, rows } })] });
    const add = (left: { work_units: number; memory_bytes: number }, right: { work_units: number; memory_bytes: number }) =>
      ({ work_units: left.work_units + right.work_units, memory_bytes: left.memory_bytes + right.memory_bytes });
    const merge = (left: AllowanceWitnessRow, right: AllowanceWitnessRow): AllowanceWitnessRow => ({
      parent: left.parent, phase: left.phase, meters: left.meters + right.meters,
      initial: add(left.initial, right.initial), remaining: add(left.remaining, right.remaining),
      spent: add(left.spent, right.spent), held: add(left.held, right.held),
      capacity: { current: add(left.capacity.current, right.capacity.current),
        adjustment: add(left.capacity.adjustment, right.capacity.adjustment),
        changes: left.capacity.changes + right.capacity.changes } });
    const part = (row: AllowanceWitnessRow, meters: number): AllowanceWitnessRow => {
      const scale = (value: { work_units: number; memory_bytes: number }) => ({
        work_units: value.work_units * meters / row.meters, memory_bytes: value.memory_bytes * meters / row.meters });
      return { ...row, meters, initial: scale(row.initial), remaining: scale(row.remaining), spent: scale(row.spent),
        held: scale(row.held), capacity: { current: scale(row.capacity.current),
          adjustment: scale(row.capacity.adjustment), changes: row.capacity.changes * meters / row.meters } };
    };
    // A sampled root plus 32 sampled children leave the trailing sibling group outside the sample.
    const capped = build([...Array(32).fill("front"), "back", "back", "back"]);
    const witness = capped.meter_allowances!;
    const back = witness.rows.find(row => row.phase === "back")!;
    const duplicateRows = witness.rows.flatMap(row => row === back ? [part(back, 2), part(back, 1)] : [structuredClone(row)]);
    const duplicate = resummarize(capped, duplicateRows);
    expect(duplicate.allowances.scoped.rows_match_meter_totals).toBe(true);
    expect(duplicate.allowances.scoped.status).toBe("invalid");
    expect(duplicate.accounting_validity).toBe("invalid");
    expect(duplicate.spent.state).toBe("unavailable");
    expect(duplicate.unknown).toContain("allowance_rows_contradictory");
    const sampled = build(["alpha", "beta"]);
    const sampledRows = sampled.meter_allowances!.rows;
    const alpha = sampledRows.find(row => row.phase === "alpha")!;
    const beta = sampledRows.find(row => row.phase === "beta")!;
    const omitted = resummarize(sampled, [structuredClone(sampledRows[0]!), merge(alpha, beta)]);
    expect(omitted.allowances.scoped.rows_match_meter_totals).toBe(true);
    expect(omitted.allowances.scoped.rows_match_sample).toBe(false);
    expect(omitted.allowances.scoped.status).toBe("invalid");
    expect(omitted.accounting_validity).toBe("invalid");
    expect(omitted.spent.state).toBe("unavailable");
    expect(omitted.unknown).toContain("allowance_sample_mismatch");
    const wrongRows = witness.rows.map(row => row.phase === "back" ? { ...structuredClone(row), meters: row.meters - 1 }
      : row.parent === null ? { ...structuredClone(row), meters: row.meters + 1 } : structuredClone(row));
    expect(wrongRows.reduce((count, row) => count + row.meters, 0))
      .toBe(capped.meter_totals!.roots + capped.meter_totals!.children);
    const wrong = resummarize(capped, wrongRows);
    expect(wrong.allowances.scoped.rows_match_meter_totals).toBe(false);
    expect(wrong.allowances.scoped.status).toBe("invalid");
    expect(wrong.accounting_validity).toBe("invalid");
    expect(wrong.spent.state).toBe("unavailable");
    expect(wrong.unknown).toContain("allowance_meter_total_mismatch");
  });

  it("detaches scoped allowance evidence from later observation mutation", () => {
    const observer = new SourceSemanticObserver(9, { max_events: 0, max_bytes: 0 });
    const root = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, observer);
    const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
    child.charge(2, 20); root.absorb(child);
    const observed = observer.finish("success");
    const before = JSON.stringify(observed);
    const result = summarizeObservationCosts({ scope: call, frames: [captured(observed)] });
    const frozen = JSON.stringify(result.allowances.scoped);
    expect(JSON.stringify(observed)).toBe(before);
    expect(result.allowances.scoped.rows[1]).not.toBe(observed.meter_allowances!.rows[1]);
    observed.meter_allowances!.rows[1]!.remaining.work_units = 0;
    expect(JSON.stringify(result.allowances.scoped)).toBe(frozen);
    expect(result.allowances.scoped.rows[1]!.remaining.work_units).toBe(8);
  });

  it("preserves complete per-kind operation totals and identity capture beyond sampling", () => {
    const row = (identity_capture: "complete" | "partial", uncompared_object_count: number) =>
      ({ kind: "retain" as const, count: 2, work: 6, bytes: 60, completed: 2, same_object_count: 1,
        same_object_work: 3, same_object_bytes: 30, uncompared_object_count, identity_capture });
    const complete = summarize({ facts: native({ operation_totals: { complete: true, rows: [row("complete", 0)] } }) });
    expect(complete.native_annotations.identity_capture).toBe("complete");
    expect(complete.native_annotations.operation_totals).toMatchObject({ complete: true,
      rows: [{ identity_capture: "complete", uncompared_object_count: 0, same_object_count: 1 }] });
    expect(complete.native_annotations).toMatchObject({ additional_debits: false, repeated_work_waste: "not_established" });
    const partial = summarize({ facts: native({ complete: false, issues: ["operation_identity_limit"],
      operation_totals: { complete: true, rows: [row("partial", 14)] } }) });
    expect(partial.native_annotations.identity_capture).toBe("partial");
    expect(partial.native_annotations.operation_totals!.rows[0]!.uncompared_object_count).toBe(14);
    expect(partial.native_annotations.repeated_work_waste).toBe("not_established");
    expect(summarize().native_annotations.identity_capture).toBe("unavailable");
  });
});
