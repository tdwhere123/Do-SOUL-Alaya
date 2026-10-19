import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { ObservationCallScope } from "./observation-attribution.js";

export const OBSERVATION_COST_CONTRACT = "longmemeval-observation-costs-v1" as const;
export type ObservationCostClass = "real_native_read" | "real_index_read" | "final_encoding"
  | "selection_encoding" | "retention_proxy" | "encoding_proxy" | "phase_allocation"
  | "unused_allowance" | "hold_transfer" | "refusal" | "absorption_transfer"
  | "duplicate_operation_label" | "unclassified" | "overflow";

export type ObservationCostAmount = Readonly<{
  state: "known" | "lower_bound" | "unavailable"; work: number | null; bytes: number | null; rows: number;
}>;
export type ObservationClassifiedCost = ObservationCostAmount & Readonly<{ class: ObservationCostClass }>;
export type ObservationMappedCostRow = Readonly<{ phase: string; reason: string; operation: string;
  count: number; work: number; bytes: number; class: ObservationCostClass }>;
export type ObservationCostSummary = Readonly<{
  contract: typeof OBSERVATION_COST_CONTRACT;
  scope: ObservationCallScope;
  observation: Readonly<{ request_id: number | null; status: string; execution: string;
    aggregates_complete: boolean; complete: boolean; dropped_events: number; issues: readonly string[] }>;
  /** Logical ledger debits, not physical memory/SQLite work. Independent row and counter sums
   * are reconciled, never added together; inconsistent/partial sums remain lower bounds. */
  spent: ObservationCostAmount;
  classification: Readonly<{ status: "complete" | "partial" | "unavailable";
    classified_debit_rows: number; total_debit_rows: number }>;
  accounting_validity: "valid" | "invalid" | "unavailable";
  /** Meter snapshots are exposed per meter; parent and child unused allowances are never summed. */
  meters: SourceSemanticObservation["meters"];
  classified: readonly ObservationClassifiedCost[];
  /** Exact row classification; unclassified rows remain visible instead of being guessed. */
  mapped_rows: readonly ObservationMappedCostRow[];
  transfers: Readonly<{
    absorbed: ObservationCostAmount; unused_allowance: ObservationCostAmount;
    holds: ObservationCostAmount; releases: ObservationCostAmount;
    refusals: ObservationCostAmount; allocations: ObservationCostAmount;
  }>;
  conservation: Readonly<{
    totals_debit_work: number | null;
    totals_debit_bytes: number | null;
    debits_match_totals: boolean | null;
    root_meter_spent_work: number | null;
    root_meter_spent_bytes: number | null;
    root_meters_match_debits: boolean | null;
    child_spent_work: number | null;
    child_spent_bytes: number | null;
    absorbed_matches_child_spent: boolean | null;
    absorbed_matches_totals: boolean | null;
    child_and_parent_unused_not_summed: true;
    unexplained_debit_work: number | null;
    unexplained_debit_bytes: number | null;
  }>;
  overhead: Readonly<{ capture_ms: number | null; event_json_bytes: number | null; ipc_bytes: null;
    ipc_time: "not_measured"; physical_peak_memory: "not_measured"; physical_sql_work: "not_measured";
    diagnostic_only: true }>;
  /** Completeness of this logical-ledger summary only; physical/IPC overhead remains separately unmeasured. */
  complete: boolean;
  unknown: readonly string[];
}>;

/** Classify recorded observation costs. Absorption/hold/release/allocation/unused are transfers or
 * allowances, never additional executed work. Unclassified rows stay unknown, not guessed. */
export function summarizeObservationCosts(input: Readonly<{
  scope: ObservationCallScope;
  observations: readonly SourceSemanticObservation[];
}>): ObservationCostSummary {
  const matches = input.scope.request_id === null ? []
    : input.observations.filter(observation => observation.request_id === input.scope.request_id);
  const frame = matches.length === 1 ? matches[0]! : null;
  const correlationProblem = frame !== null ? null : input.scope.request_id === null
    ? "observation_request_unscoped" : matches.length === 0 ? "observation_missing_for_request"
      : "ambiguous_observation_request";
  const costs = frame?.costs ?? [];
  const duplicateLabels = new Set(costs.filter(row => row.operation === "native_read" || row.operation === "index_native")
    .map(row => `${row.phase}\u0000${row.reason}\u0000${row.operation}`));
  const rows = costs.map(row => ({ ...row, class: classify(row, duplicateLabels) }));
  const debits = rows.filter(row => row.operation === "debit");
  const debitSum = sum(debits);
  const aggregatesKnown = frame !== null && frame.aggregates_complete && frame.totals !== null
    && frame.issues.length === 0 && (frame.status === "observed" || frame.status === "overflow");
  const observationComplete = frame !== null && frame.status === "observed" && frame.execution === "success"
    && frame.dropped_events === 0 && frame.aggregates_complete && frame.issues.length === 0;
  const classified = aggregate(rows, aggregatesKnown);
  const absorbed = sum(rows.filter(row => row.operation === "absorb"));
  const transfers = {
    absorbed: amount(absorbed, aggregatesKnown),
    unused_allowance: amount(sum(rows.filter(row => row.operation === "unused")), aggregatesKnown),
    holds: amount(sum(rows.filter(row => row.operation === "hold")), aggregatesKnown),
    releases: amount(sum(rows.filter(row => row.operation === "release")), aggregatesKnown),
    refusals: amount(sum(rows.filter(row => row.operation === "refused")), aggregatesKnown),
    allocations: amount(sum(rows.filter(row => row.operation === "allocation")), aggregatesKnown)
  };
  const roots = frame?.meters.filter(meter => meter.parent === null) ?? [];
  const children = frame?.meters.filter(meter => meter.parent !== null) ?? [];
  const rootSpent = meterSum(roots, "spent");
  const childSpent = meterSum(children, "spent");
  const totalsWork = frame?.totals?.debit_work ?? null;
  const totalsBytes = frame?.totals?.debit_bytes ?? null;
  const debitsMatchTotals = totalsWork === null || totalsBytes === null ? null
    : debitSum.work === totalsWork && debitSum.bytes === totalsBytes;
  const rootMatches = frame === null || roots.length === 0 ? null
    : rootSpent.work === debitSum.work && rootSpent.bytes === debitSum.bytes;
  const absorbedMatches = frame === null || frame.meters.length === 0 ? null
    : absorbed.work === childSpent.work && absorbed.bytes === childSpent.bytes;
  const absorbedTotalsMatch = frame?.totals == null ? null
    : absorbed.work === frame.totals.absorb_work && absorbed.bytes === frame.totals.absorb_bytes;
  const checks = [debitsMatchTotals, rootMatches, absorbedMatches, absorbedTotalsMatch];
  const accountingValidity = checks.includes(false) ? "invalid" : checks.includes(null) || !aggregatesKnown ? "unavailable" : "valid";
  const spent = amount({ work: Math.max(debitSum.work, totalsWork ?? 0),
    bytes: Math.max(debitSum.bytes, totalsBytes ?? 0), rows: debitSum.rows }, aggregatesKnown && accountingValidity !== "invalid");
  const unclassified = debits.filter(row => row.class === "unclassified" || row.class === "overflow").length;
  const classification = { status: !aggregatesKnown && debits.length === 0 ? "unavailable" as const
    : aggregatesKnown && unclassified === 0 ? "complete" as const : "partial" as const,
    classified_debit_rows: debits.length - unclassified, total_debit_rows: debits.length };
  const unknown = [
    ...(correlationProblem === null ? [] : [correlationProblem]),
    ...(frame !== null && frame.totals === null ? ["totals_unavailable"] : []),
    ...(frame !== null && !frame.aggregates_complete ? ["aggregates_incomplete"] : []),
    ...(frame !== null && frame.dropped_events > 0 ? ["events_dropped"] : []),
    ...(frame?.issues ?? []),
    ...(frame !== null && frame.overhead.ipc_bytes === null ? ["ipc_bytes_not_measured"] : []),
    ...(frame !== null ? ["physical_sql_work_not_measured", "physical_peak_memory_not_measured"] : []),
    ...(unclassified > 0 ? ["unclassified_cost_rows"] : []),
    ...(debitsMatchTotals === false ? ["debit_total_mismatch"] : []),
    ...(rootMatches === false ? ["root_meter_mismatch"] : []),
    ...(absorbedMatches === false ? ["absorb_meter_mismatch"] : []),
    ...(absorbedTotalsMatch === false ? ["absorb_total_mismatch"] : []),
    ...(accountingValidity === "unavailable" ? ["accounting_validity_unavailable"] : []),
    ...(!observationComplete && frame !== null ? ["observation_incomplete"] : [])
  ];
  return { contract: OBSERVATION_COST_CONTRACT, scope: input.scope,
    observation: { request_id: frame?.request_id ?? null, status: frame?.status ?? "unavailable",
      execution: frame?.execution ?? "unknown", aggregates_complete: frame?.aggregates_complete ?? false,
      complete: observationComplete, dropped_events: frame?.dropped_events ?? 0, issues: frame?.issues ?? [] },
    spent, classification, accounting_validity: accountingValidity, meters: frame?.meters ?? [], classified, mapped_rows: rows, transfers,
    conservation: { totals_debit_work: totalsWork, totals_debit_bytes: totalsBytes, debits_match_totals: debitsMatchTotals,
      root_meter_spent_work: roots.length === 0 ? null : rootSpent.work,
      root_meter_spent_bytes: roots.length === 0 ? null : rootSpent.bytes,
      root_meters_match_debits: rootMatches,
      child_spent_work: frame === null || frame.meters.length === 0 ? null : childSpent.work,
      child_spent_bytes: frame === null || frame.meters.length === 0 ? null : childSpent.bytes,
      absorbed_matches_child_spent: absorbedMatches, absorbed_matches_totals: absorbedTotalsMatch,
      child_and_parent_unused_not_summed: true,
      unexplained_debit_work: totalsWork === null ? null : debitSum.work - totalsWork,
      unexplained_debit_bytes: totalsBytes === null ? null : debitSum.bytes - totalsBytes },
    overhead: { capture_ms: frame?.overhead.capture_ms ?? null,
      event_json_bytes: frame?.overhead.event_json_bytes ?? null, ipc_bytes: null,
      ipc_time: "not_measured", physical_peak_memory: "not_measured", physical_sql_work: "not_measured",
      diagnostic_only: true },
    complete: observationComplete && spent.state === "known" && classification.status === "complete" && accountingValidity === "valid",
    unknown };
}

function classify(row: SourceSemanticObservation["costs"][number], duplicateLabels: ReadonlySet<string>): ObservationCostClass {
  if (row.operation === "native_read") return "duplicate_operation_label";
  if (row.operation === "index_native") return "duplicate_operation_label";
  if (row.operation === "absorb") return "absorption_transfer";
  if (row.operation === "unused") return "unused_allowance";
  if (row.operation === "hold" || row.operation === "release") return "hold_transfer";
  if (row.operation === "refused") return "refusal";
  if (row.operation === "allocation") return "phase_allocation";
  if (row.phase === "overflow" || row.reason === "other") return "overflow";
  if (row.operation !== "debit") return "unclassified";
  if (row.reason === "library public serialization" || row.reason === "optional source time codec encoding") return "final_encoding";
  if (duplicateLabels.has(`${row.phase}\u0000${row.reason}\u0000native_read`)) return "real_native_read";
  if (duplicateLabels.has(`${row.phase}\u0000${row.reason}\u0000index_native`)) return "real_index_read";
  if (/^candidate (partial )?delivery (bytes|encoding)$/.test(row.reason)) return "selection_encoding";
  if (row.reason === "source index acquisition") return "real_index_read";
  if (row.reason === "native source read" || row.reason === "access verified source extent") return "real_native_read";
  if (/retention|assembly|allocation/i.test(row.reason)) return "retention_proxy";
  if (/encoding|serialization/i.test(row.reason)) return "encoding_proxy";
  return "unclassified";
}

function aggregate(rows: readonly (SourceSemanticObservation["costs"][number] & { class: ObservationCostClass })[], known: boolean) {
  const classes: readonly ObservationCostClass[] = ["real_native_read", "real_index_read", "final_encoding",
    "selection_encoding", "retention_proxy", "encoding_proxy", "phase_allocation", "unused_allowance",
    "hold_transfer", "refusal", "absorption_transfer", "duplicate_operation_label", "unclassified", "overflow"];
  return classes.map(name => ({ class: name, ...amount(sum(rows.filter(row => row.class === name)), known) }));
}
function sum(rows: readonly { work: number; bytes: number }[]) {
  return { work: rows.reduce((total, row) => total + row.work, 0),
    bytes: rows.reduce((total, row) => total + row.bytes, 0), rows: rows.length };
}
function amount(value: { work: number; bytes: number; rows: number }, known: boolean): ObservationCostAmount {
  if (known) return { state: "known", ...value };
  if (value.rows > 0 || value.work > 0 || value.bytes > 0) return { state: "lower_bound", ...value };
  return { state: "unavailable", work: null, bytes: null, rows: value.rows };
}
function meterSum(meters: SourceSemanticObservation["meters"], field: "spent") {
  return { work: meters.reduce((total, meter) => total + meter[field].work_units, 0),
    bytes: meters.reduce((total, meter) => total + meter[field].memory_bytes, 0) };
}
