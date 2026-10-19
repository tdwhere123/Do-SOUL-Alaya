import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import { joinObservationFrames, observationFrameComplete, type ObservationCallScope, type ObservationCapturedFrame } from "./observation-ancestry.js";

export const OBSERVATION_COST_CONTRACT = "longmemeval-observation-costs-v1" as const;
export type ObservationCostClass = "real_native_read" | "real_index_read" | "final_encoding"
  | "selection_encoding" | "retention_proxy" | "encoding_proxy" | "phase_allocation"
  | "unused_allowance" | "hold_transfer" | "refusal" | "absorption_transfer"
  | "canonical_scan_proxy" | "duplicate_operation_label" | "unclassified" | "overflow";

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
   * are reconciled, never added together. Partial sums are lower bounds; contradictory
   * complete counters make spent unavailable. */
  spent: ObservationCostAmount;
  classification: Readonly<{ status: "complete" | "partial" | "unavailable";
    classified_debit_rows: number; total_debit_rows: number }>;
  accounting_validity: "valid" | "invalid" | "unavailable";
  /** Meter snapshots are exposed per meter; parent and child unused allowances are never summed. */
  meters: SourceSemanticObservation["meters"];
  classified: readonly ObservationClassifiedCost[];
  /** Exact row classification; unclassified rows remain visible instead of being guessed. */
  mapped_rows: readonly ObservationMappedCostRow[];
  /** Annotation of already charged rows, never extra debits or a claim that repetition is waste. */
  native_annotations: Readonly<{
    status: "complete" | "partial" | "unavailable"; issues: readonly string[];
    operations: readonly (SourceSemanticNativeFacts["operations"][number] & Readonly<{
      debit_row_positions: readonly number[]; matches_recorded_debits: boolean;
    }>)[];
    encodings: SourceSemanticNativeFacts["encodings"];
    additional_debits: false; repeated_work_waste: "not_established";
  }>;
  /** Remaining capacity and future commitments are local to each meter, not additive across
   * a parent/child tree. Raw absorption-time unused rows are retained without a global sum. */
  allowances: Readonly<{ aggregation: "per_meter_only";
    unused_rows: readonly ObservationMappedCostRow[]; meters: SourceSemanticObservation["meters"] }>;
  /** Partition of captured debit rows only. Independent counters and meter reconciliation
   * below still decide whether those rows establish the actual spent amount. */
  decomposition: Readonly<{ debit_work: number; debit_bytes: number; conserved: boolean }>;
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
  frames: readonly ObservationCapturedFrame[];
}>): ObservationCostSummary {
  const joined = joinObservationFrames(input.scope, input.frames);
  const frame = joined.target;
  const correlationProblem = frame === null ? joined.issues[0] ?? "observation_missing_for_request" : null;
  const costs = frame?.costs ?? [];
  const duplicateLabels = new Set(costs.filter(row => row.operation === "native_read" || row.operation === "index_native")
    .map(row => `${row.phase}\u0000${row.reason}\u0000${row.operation}`));
  const facts = frame?.facts;
  const rows = costs.map(row => ({ ...row, class: classify(row, duplicateLabels, facts?.operations ?? []) }));
  const debits = rows.filter(row => row.operation === "debit");
  const debitSum = sum(debits);
  const aggregatesKnown = frame !== null && frame.aggregates_complete && frame.totals !== null
    && frame.issues.length === 0 && (frame.status === "observed" || frame.status === "overflow");
  const observationComplete = frame !== null && observationFrameComplete(frame);
  const classified = aggregate(debits, aggregatesKnown);
  const nativeAnnotations = annotateNative(facts, rows);
  const unusedRows = rows.filter(row => row.operation === "unused");
  const absorbed = sum(rows.filter(row => row.operation === "absorb"));
  const transfers = {
    absorbed: amount(absorbed, aggregatesKnown),
    unused_allowance: { state: "unavailable" as const, work: null, bytes: null, rows: unusedRows.length },
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
  // Contradictory complete counters establish neither a total nor a lower bound.
  // Keep the raw rows and reconciliation values below for diagnosis.
  const spent: ObservationCostAmount = aggregatesKnown && accountingValidity === "invalid"
    ? { state: "unavailable", work: null, bytes: null, rows: debitSum.rows }
    : amount({ work: Math.max(debitSum.work, totalsWork ?? 0),
      bytes: Math.max(debitSum.bytes, totalsBytes ?? 0), rows: debitSum.rows }, aggregatesKnown);
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
    native_annotations: nativeAnnotations,
    allowances: { aggregation: "per_meter_only", unused_rows: unusedRows, meters: frame?.meters ?? [] },
    decomposition: { debit_work: debitSum.work, debit_bytes: debitSum.bytes,
      conserved: classified.reduce((total, row) => total + (row.work ?? 0), 0) === debitSum.work
        && classified.reduce((total, row) => total + (row.bytes ?? 0), 0) === debitSum.bytes },
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

function classify(row: SourceSemanticObservation["costs"][number], duplicateLabels: ReadonlySet<string>,
  operations: SourceSemanticNativeFacts["operations"]): ObservationCostClass {
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
  if (operations.some(operation => operation.kind === "retain" && operation.phase === row.phase && operation.reason === row.reason)) return "retention_proxy";
  if (/^canonical size (traversal|integer scan|numeric encoding|string scan)$/.test(row.reason)) return "canonical_scan_proxy";
  if (/retention|assembly|allocation/i.test(row.reason)) return "retention_proxy";
  if (/encoding|serialization/i.test(row.reason)) return "encoding_proxy";
  return "unclassified";
}

function annotateNative(facts: SourceSemanticNativeFacts | undefined, rows: readonly ObservationMappedCostRow[]): ObservationCostSummary["native_annotations"] {
  return { status: facts === undefined ? "unavailable" : facts.complete && facts.issues.length === 0 ? "complete" : "partial",
    issues: facts?.issues ?? ["native_operation_and_encoding_facts_unavailable"], operations: (facts?.operations ?? []).map(operation => {
      const positions = rows.flatMap((row, index) => row.operation === "debit" && row.phase === operation.phase
        && (row.reason === operation.reason || operation.kind === "canonical_scan" && /^canonical size /.test(row.reason)) ? [index] : []);
      const matched = sum(positions.map(position => rows[position]!));
      // Several meters can share a phase/reason. Only their combined native operation aggregate
      // can be reconciled to that cost row; a single meter must not claim the whole row.
      const peers = facts!.operations.filter(peer => peer.phase === operation.phase && peer.kind === operation.kind
        && peer.reason === operation.reason);
      const peerSum = sum(peers);
      return { ...operation, debit_row_positions: positions,
        matches_recorded_debits: matched.work === peerSum.work && matched.bytes === peerSum.bytes };
    }), encodings: facts?.encodings ?? [], additional_debits: false, repeated_work_waste: "not_established" };
}

function aggregate(rows: readonly (SourceSemanticObservation["costs"][number] & { class: ObservationCostClass })[], known: boolean) {
  const classes: readonly ObservationCostClass[] = ["real_native_read", "real_index_read", "final_encoding",
    "selection_encoding", "retention_proxy", "encoding_proxy", "phase_allocation", "unused_allowance",
    "hold_transfer", "refusal", "absorption_transfer", "canonical_scan_proxy", "duplicate_operation_label", "unclassified", "overflow"];
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
