import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import { joinObservationFrames, observationFrameComplete, type ObservationCallScope, type ObservationCapturedFrame } from "./observation-ancestry.js";

export const OBSERVATION_COST_CONTRACT = "longmemeval-observation-costs-v1" as const;
export type ObservationCostClass = "real_native_read" | "real_index_read" | "final_encoding"
  | "selection_encoding" | "retention_proxy" | "encoding_proxy" | "phase_allocation"
  | "unused_allowance" | "hold_transfer" | "refusal" | "absorption_transfer"
  | "canonical_scan_proxy" | "real_computation" | "computation_proxy" | "canonical_identity" | "telemetry" | "capacity_adjustment"
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
      debit_row_positions: readonly number[]; matches_recorded_debits: boolean | null;
    }>)[];
    operation_totals: SourceSemanticNativeFacts["operation_totals"] | null;
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
    root_balances_match: boolean | null;
    captured_capacity_balances_match: boolean | null;
    meter_aggregate_matches_sample: boolean | null;
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
    && frame.issues.every(issue => issue === "meter_detail_limit") && (frame.status === "observed" || frame.status === "overflow");
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
  const meters = reconcileMeters(frame);
  const { rootSpent, childSpent } = meters;
  const totalsWork = frame?.totals?.debit_work ?? null;
  const totalsBytes = frame?.totals?.debit_bytes ?? null;
  const debitsMatchTotals = totalsWork === null || totalsBytes === null ? null
    : debitSum.work === totalsWork && debitSum.bytes === totalsBytes;
  const rootMatches = rootSpent === null ? null : rootSpent.work === debitSum.work && rootSpent.bytes === debitSum.bytes;
  const absorbedMatches = childSpent === null ? null : absorbed.work === childSpent.work && absorbed.bytes === childSpent.bytes;
  const absorbedTotalsMatch = frame?.totals == null ? null
    : absorbed.work === frame.totals.absorb_work && absorbed.bytes === frame.totals.absorb_bytes;
  const checks = [debitsMatchTotals, rootMatches, absorbedMatches, absorbedTotalsMatch,
    meters.rootBalancesMatch, meters.capacityBalancesMatch,
    ...(frame?.meter_totals === undefined ? [] : [meters.aggregateMatchesSample])];
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
    ...(meters.rootBalancesMatch === false ? ["root_balance_mismatch"] : []),
    ...(meters.capacityBalancesMatch === false ? ["capacity_balance_mismatch"] : []),
    ...(meters.aggregateMatchesSample === false ? ["meter_aggregate_sample_mismatch"] : []),
    ...(childSpent === null && frame !== null ? ["complete_child_spend_unavailable"] : []),
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
      root_meter_spent_work: rootSpent?.work ?? null,
      root_meter_spent_bytes: rootSpent?.bytes ?? null,
      root_meters_match_debits: rootMatches,
      root_balances_match: meters.rootBalancesMatch, captured_capacity_balances_match: meters.capacityBalancesMatch,
      meter_aggregate_matches_sample: meters.aggregateMatchesSample,
      child_spent_work: childSpent?.work ?? null,
      child_spent_bytes: childSpent?.bytes ?? null,
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

/** Exact reason mapping is owned here, not inferred from English substrings. These are
 * logical charges around the cited executed operations, NOT measured CPU/RSS or recoverable waste. */
const DEBIT_CLASSES: Readonly<Record<string, ObservationCostClass>> = {
  // Core recall/runtime/source-semantic-access.ts: score() executes normalization/scoring;
  // order() executes sorting. Feature charges also cover navigation-only calls, hence proxy.
  "access text normalization and scoring": "real_computation",
  "access query features": "computation_proxy",
  "access ordering": "real_computation",
  "access source hint association": "real_computation",
  // Core recall/runtime/source-semantic-library-selection.ts: candidate frames, support
  // projection, coverage scoring and local exchanges are actually computed, even if not selected.
  "evidence selection candidates": "real_computation",
  "selection support projection": "real_computation",
  "evidence coverage comparison": "real_computation",
  "evidence coverage exchange": "real_computation",
  // Daemon source-semantic-library-delivery.ts: root census and public encoding.
  "library page root census": "real_computation",
  "library unproved computation page selection": "real_computation",
  "library public serialization": "final_encoding",
  "candidate delivery bytes": "selection_encoding",
  "candidate delivery encoding": "selection_encoding",
  "candidate partial delivery bytes": "selection_encoding",
  "candidate partial delivery encoding": "selection_encoding",
  "optional source time codec encoding": "final_encoding",
  "optional source time packing": "encoding_proxy",
  "optional source time semantic capture": "retention_proxy",
  "optional source time codec allocation": "retention_proxy",
  "library disclosure codec allocation": "retention_proxy",
  // Daemon source-semantic-library-packages.ts: conservative UTF-8 hydration price;
  // it is not candidate whole-page re-encoding and is not proven avoidable.
  "library source window encoding": "encoding_proxy",
  // Daemon candidate-access/leases/source-observation/read-stores owners call retain,
  // or conservatively price copies/joins. Quotation traversal is not a new source read.
  "preparation lease": "retention_proxy",
  "access receipt identity": "retention_proxy",
  "access trace delivery": "retention_proxy",
  "access source observation continuation": "retention_proxy",
  "source union tuple identity": "retention_proxy",
  "access source retention": "retention_proxy",
  "access source assembly": "retention_proxy",
  "source retention": "retention_proxy",
  "source assembly": "retention_proxy",
  "current source catalog": "retention_proxy",
  "access pending verification retention": "retention_proxy",
  "access header identity retention": "retention_proxy",
  "access cursor reference retention": "retention_proxy",
  // Protocol garden/source-semantic-resources.ts: pricing traversals and numeric quotes.
  "retained value measurement work": "retention_proxy",
  "retained numeric price reference": "retention_proxy",
  "retained price snapshot allocation": "retention_proxy",
  "retained object price composition": "retention_proxy",
  // Protocol selection/capture/canonical-json.ts and Core shared/field-hash.ts:
  // canonical identity construction/hash handoff is not final consumer-page encoding.
  "canonical identity traversal": "canonical_identity",
  "canonical identity key ordering": "canonical_identity",
  "canonical identity key comparison": "canonical_identity",
  "canonical identity scalar encoding": "canonical_identity",
  "canonical identity hash handoff": "canonical_identity",
  "canonical size traversal": "canonical_scan_proxy",
  "canonical size integer scan": "canonical_scan_proxy",
  "canonical size numeric encoding": "canonical_scan_proxy",
  "canonical size string scan": "canonical_scan_proxy",
  // Daemon candidate-access.ts projects provenance rows, not source content. This is
  // request-ledger telemetry; private observer allocations/timing remain outside it.
  "access trace selection": "telemetry"
};

function classify(row: SourceSemanticObservation["costs"][number], duplicateLabels: ReadonlySet<string>,
  operations: SourceSemanticNativeFacts["operations"]): ObservationCostClass {
  if (row.operation === "native_read") return "duplicate_operation_label";
  if (row.operation === "index_native") return "duplicate_operation_label";
  if (row.operation === "absorb") return "absorption_transfer";
  if (row.operation === "unused") return "unused_allowance";
  if (row.operation === "hold" || row.operation === "release") return "hold_transfer";
  if (row.operation === "refused") return "refusal";
  if (row.operation === "allocation") return "phase_allocation";
  if (row.operation === "capacity_increase" || row.operation === "capacity_decrease") return "capacity_adjustment";
  if (row.phase === "overflow" || row.reason === "other") return "overflow";
  if (row.operation !== "debit") return "unclassified";
  if (duplicateLabels.has(`${row.phase}\u0000${row.reason}\u0000native_read`)) return "real_native_read";
  if (duplicateLabels.has(`${row.phase}\u0000${row.reason}\u0000index_native`)) return "real_index_read";
  if (row.reason === "source index acquisition") return "real_index_read";
  if (row.reason === "native source read" || row.reason === "access verified source extent") return "real_native_read";
  const owned = Object.hasOwn(DEBIT_CLASSES, row.reason) ? DEBIT_CLASSES[row.reason] : undefined;
  if (owned !== undefined) return owned;
  if (operations.some(operation => operation.kind === "retain" && operation.phase === row.phase && operation.reason === row.reason)) return "retention_proxy";
  return "unclassified";
}

function annotateNative(facts: SourceSemanticNativeFacts | undefined, rows: readonly ObservationMappedCostRow[]): ObservationCostSummary["native_annotations"] {
  return { status: facts === undefined ? "unavailable" : facts.complete && facts.issues.length === 0 ? "complete" : "partial",
    issues: facts?.issues ?? ["native_operation_and_encoding_facts_unavailable"],
    operation_totals: facts?.operation_totals ?? null, operations: (facts?.operations ?? []).map(operation => {
      const positions = rows.flatMap((row, index) => row.operation === "debit" && row.phase === operation.phase
        && (row.reason === operation.reason || operation.kind === "canonical_scan" && /^canonical size /.test(row.reason)) ? [index] : []);
      const matched = sum(positions.map(position => rows[position]!));
      // Several meters can share a phase/reason. Only their combined native operation aggregate
      // can be reconciled to that cost row; a single meter must not claim the whole row.
      const peers = facts!.operations.filter(peer => peer.phase === operation.phase && peer.kind === operation.kind
        && peer.reason === operation.reason);
      const peerSum = sum(peers);
      return { ...operation, debit_row_positions: positions,
        matches_recorded_debits: facts!.issues.includes("operation_fact_limit") ? null
          : matched.work === peerSum.work && matched.bytes === peerSum.bytes };
    }), encodings: facts?.encodings ?? [], additional_debits: false, repeated_work_waste: "not_established" };
}

function aggregate(rows: readonly (SourceSemanticObservation["costs"][number] & { class: ObservationCostClass })[], known: boolean) {
  const classes: readonly ObservationCostClass[] = ["real_native_read", "real_index_read", "final_encoding",
    "selection_encoding", "retention_proxy", "encoding_proxy", "phase_allocation", "unused_allowance",
    "hold_transfer", "refusal", "absorption_transfer", "canonical_scan_proxy", "real_computation", "computation_proxy", "canonical_identity",
    "telemetry", "capacity_adjustment", "duplicate_operation_label", "unclassified", "overflow"];
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
function reconcileMeters(frame: SourceSemanticObservation | null) {
  const roots = frame?.meters.filter(meter => meter.parent === null) ?? [];
  const children = frame?.meters.filter(meter => meter.parent !== null) ?? [];
  const spent = (meters: SourceSemanticObservation["meters"]) => ({
    work: meters.reduce((total, meter) => total + meter.spent.work_units, 0),
    bytes: meters.reduce((total, meter) => total + meter.spent.memory_bytes, 0) });
  const rootSample = spent(roots), childSample = spent(children), totals = frame?.meter_totals;
  const detailIncomplete = frame?.issues.includes("meter_detail_limit") ?? false;
  const rootSpent = totals?.complete ? { work: totals.root_spent.work_units, bytes: totals.root_spent.memory_bytes }
    : roots.length > 0 ? rootSample : null;
  // Historical capped snapshots cannot witness all absorbed children. Never compare a
  // complete transfer with that sample, nor manufacture missing child spend from transfers.
  const childSpent = totals?.complete ? { work: totals.child_spent.work_units, bytes: totals.child_spent.memory_bytes }
    : frame !== null && frame.meters.length > 0 && !detailIncomplete ? childSample : null;
  const balanced = (meter: SourceSemanticObservation["meters"][number]) => {
    const sumWork = meter.remaining.work_units + meter.spent.work_units + meter.held.work_units;
    const sumBytes = meter.remaining.memory_bytes + meter.spent.memory_bytes + meter.held.memory_bytes;
    const capacity = meter.capacity;
    if (capacity === undefined) {
      const equal = meter.initial.work_units === sumWork && meter.initial.memory_bytes === sumBytes;
      // Legacy children may have been promoted/constrained without an adjustment witness.
      return equal ? true : meter.parent === null ? false : null;
    }
    return meter.initial.work_units + capacity.adjustment.work_units === capacity.current.work_units
      && meter.initial.memory_bytes + capacity.adjustment.memory_bytes === capacity.current.memory_bytes
      && capacity.current.work_units === sumWork && capacity.current.memory_bytes === sumBytes;
  };
  const combine = (checks: readonly (boolean | null)[]): boolean | null => checks.includes(false) ? false
    : checks.length === 0 || checks.includes(null) ? null : true;
  const sampleMatches = (sample: typeof rootSample, captured: number, count: number,
    total: { work_units: number; memory_bytes: number }) => captured <= count && (captured === count
    ? sample.work === total.work_units && sample.bytes === total.memory_bytes
    : sample.work <= total.work_units && sample.bytes <= total.memory_bytes);
  const aggregateMatchesSample = !totals?.complete ? null :
    sampleMatches(rootSample, roots.length, totals.roots, totals.root_spent)
    && sampleMatches(childSample, children.length, totals.children, totals.child_spent)
    && (totals.roots + totals.children === (frame?.meters.length ?? 0)
      || detailIncomplete && frame?.meters.length === 32);
  return { rootSpent, childSpent, rootBalancesMatch: combine(roots.map(balanced)),
    capacityBalancesMatch: combine((frame?.meters ?? []).map(balanced)), aggregateMatchesSample };
}
