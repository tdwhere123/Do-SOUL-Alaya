import type { OpenSemanticFactorFormationCapture } from
  "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import {
  OPEN_SEMANTIC_FACTOR_COMPATIBILITY_OPERATOR_ID,
  materializeOpenSemanticFactorCompatibility,
  type OpenSemanticFactorCompatibilityReceipt
} from "./compatibility.js";
import { compareText } from "../../../shared/compare-text.js";

export const OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID =
  "open_semantic_factor_compatibility_trace_v2";

export type OpenSemanticFactorIncomparableSeal =
  | "none"
  | "ineligible"
  | "unavailable"
  | "rejected";

export type OpenSemanticFactorCompatibilityTraceEntry = Readonly<{
  readonly evidence_id: string;
  readonly receipt: Readonly<OpenSemanticFactorCompatibilityReceipt>;
}>;

export type OpenSemanticFactorCompatibilityTrace = Readonly<{
  readonly schema_version: 2;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID;
  readonly query_capture_digest: string;
  readonly observed_evidence_count: number;
  readonly matchable_evidence_count: number;
  readonly evaluated_evidence_count: number;
  readonly unavailable_evidence_ids: readonly string[];
  readonly unevaluated_evidence_ids: readonly string[];
  readonly incomparable_seal: OpenSemanticFactorIncomparableSeal;
  readonly truncated: boolean;
  readonly entries: readonly Readonly<OpenSemanticFactorCompatibilityTraceEntry>[];
  readonly trace_digest: RecallFieldDigest;
}>;

const INCOMPARABLE_SEALS = Object.freeze([
  "none",
  "ineligible",
  "unavailable",
  "rejected"
] as const satisfies readonly OpenSemanticFactorIncomparableSeal[]);

export function materializeOpenSemanticFactorCompatibilityTrace(params: Readonly<{
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
  readonly evidence_formations: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
  readonly unavailable_evidence_ids?: readonly string[];
}>): OpenSemanticFactorCompatibilityTrace {
  const observed = Object.entries(params.evidence_formations)
    .filter(([evidenceId]) => evidenceId.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const observedIds = new Set(observed.map(([evidenceId]) => evidenceId));
  const unavailableEvidenceIds = uniqueSortedIds(
    (params.unavailable_evidence_ids ?? [])
      .filter((evidenceId) => !observedIds.has(evidenceId))
  );
  const matchable = observed.filter(([, capture]) =>
    captureIsMatchable(capture, params.query_capture));
  const entries = evaluateMatchableEntries(matchable, params.query_capture);
  // Observed unformed IDs are not named in unavailable_evidence_ids; that field
  // only counts captures absent from evidence_formations.
  const unevaluatedEvidenceIds = listUnevaluatedEvidenceIds(
    observed,
    params.query_capture,
    unavailableEvidenceIds
  );
  const body = Object.freeze({
    schema_version: 2 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID,
    query_capture_digest: params.query_capture.capture_digest,
    observed_evidence_count: observed.length + unavailableEvidenceIds.length,
    matchable_evidence_count: matchable.length,
    evaluated_evidence_count: entries.length,
    unavailable_evidence_ids: unavailableEvidenceIds,
    unevaluated_evidence_ids: unevaluatedEvidenceIds,
    incomparable_seal: dominantIncomparableSeal(
      observed,
      matchable.length,
      params.query_capture,
      unavailableEvidenceIds.length > 0
    ),
    // Remainder rows are incomparable, so they cannot change the match set.
    truncated: matchable.length > entries.length,
    entries
  });
  return Object.freeze({
    ...body,
    trace_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyOpenSemanticFactorCompatibilityTrace(
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>
): OpenSemanticFactorCompatibilityTrace {
  const { trace_digest: _digest, ...body } = trace;
  const evidenceIds = new Set<string>();
  const evaluatedIds = new Set(trace.entries.map((entry) => entry.evidence_id));
  const unevaluatedSet = new Set(trace.unevaluated_evidence_ids);
  const remainderBudget = trace.observed_evidence_count - trace.matchable_evidence_count;
  const entriesValid = trace.entries.every((entry) => {
    const { receipt_digest: _receiptDigest, ...receiptBody } = entry.receipt;
    const unique = !evidenceIds.has(entry.evidence_id);
    evidenceIds.add(entry.evidence_id);
    return unique && entry.evidence_id.trim().length > 0 &&
      entry.receipt.operator_id === OPEN_SEMANTIC_FACTOR_COMPATIBILITY_OPERATOR_ID &&
      entry.receipt.query_capture_digest === trace.query_capture_digest &&
      digestRecallFieldIdentity(receiptBody) === entry.receipt.receipt_digest;
  });
  if (trace.schema_version !== 2 ||
      trace.operator_id !== OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID ||
      trace.evaluated_evidence_count !== trace.entries.length ||
      trace.matchable_evidence_count < trace.evaluated_evidence_count ||
      trace.observed_evidence_count < trace.matchable_evidence_count ||
      trace.unavailable_evidence_ids.length > remainderBudget ||
      trace.unevaluated_evidence_ids.length !== remainderBudget ||
      !uniqueSortedDisjoint(trace.unavailable_evidence_ids, evaluatedIds) ||
      !uniqueSortedDisjoint(trace.unevaluated_evidence_ids, evaluatedIds) ||
      !trace.unavailable_evidence_ids.every((evidenceId) => unevaluatedSet.has(evidenceId)) ||
      !INCOMPARABLE_SEALS.includes(trace.incomparable_seal) ||
      (trace.incomparable_seal === "none") !==
        (trace.observed_evidence_count === trace.matchable_evidence_count &&
          trace.unevaluated_evidence_ids.length === 0) ||
      trace.truncated !== (
        trace.matchable_evidence_count > trace.evaluated_evidence_count
      ) || !entriesValid ||
      digestRecallFieldIdentity(body) !== trace.trace_digest) {
    throw new Error("open semantic factor compatibility trace contract mismatch");
  }
  return trace as OpenSemanticFactorCompatibilityTrace;
}

function evaluateMatchableEntries(
  matchable: readonly (readonly [string, Readonly<OpenSemanticFactorFormationCapture>])[],
  queryCapture: Readonly<OpenSemanticFactorFormationCapture>
): OpenSemanticFactorCompatibilityTrace["entries"] {
  return Object.freeze(matchable.map(([evidenceId, evidenceCapture]) =>
    Object.freeze({
      evidence_id: evidenceId,
      receipt: materializeOpenSemanticFactorCompatibility({
        evidence_capture: evidenceCapture,
        query_capture: queryCapture
      })
    })));
}

function captureHasFormedGraph(
  capture: Readonly<OpenSemanticFactorFormationCapture>
): boolean {
  return capture.status === "formed" && capture.graph !== null;
}

function captureIsMatchable(
  evidence: Readonly<OpenSemanticFactorFormationCapture>,
  query: Readonly<OpenSemanticFactorFormationCapture>
): boolean {
  return captureHasFormedGraph(evidence) && captureHasFormedGraph(query);
}

function listUnevaluatedEvidenceIds(
  observed: readonly (readonly [string, Readonly<OpenSemanticFactorFormationCapture>])[],
  query: Readonly<OpenSemanticFactorFormationCapture>,
  namedUnavailableIds: readonly string[]
): readonly string[] {
  return uniqueSortedIds([
    ...observed.flatMap(([evidenceId, capture]) =>
      captureIsMatchable(capture, query) ? [] : [evidenceId]),
    ...namedUnavailableIds
  ]);
}

function uniqueSortedIds(ids: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(
    ids.filter((evidenceId) => evidenceId.trim().length > 0)
  )].sort(compareText));
}

function uniqueSortedDisjoint(
  ids: readonly string[],
  excluded: ReadonlySet<string>
): boolean {
  return ids.every((evidenceId, index) =>
    evidenceId.trim().length > 0 &&
    (index === 0 || ids[index - 1]! < evidenceId) &&
    !excluded.has(evidenceId));
}

function dominantIncomparableSeal(
  observed: readonly (readonly [string, Readonly<OpenSemanticFactorFormationCapture>])[],
  matchableCount: number,
  query: Readonly<OpenSemanticFactorFormationCapture>,
  hasUnavailableEvidence: boolean
): OpenSemanticFactorIncomparableSeal {
  if (matchableCount === observed.length && !hasUnavailableEvidence) return "none";
  // Evidence-only seals miss query-unformed remainders.
  let seal = sealFromCapture(query);
  if (hasUnavailableEvidence && seal === "none") seal = "unavailable";
  if (seal === "rejected") return "rejected";
  for (const [, capture] of observed) {
    const next = sealFromCapture(capture);
    if (next === "rejected") return "rejected";
    if (INCOMPARABLE_SEALS.indexOf(next) > INCOMPARABLE_SEALS.indexOf(seal)) {
      seal = next;
    }
  }
  return seal;
}

function sealFromCapture(
  capture: Readonly<OpenSemanticFactorFormationCapture>
): OpenSemanticFactorIncomparableSeal {
  if (capture.status === "rejected" ||
      capture.status === "unavailable" ||
      capture.status === "ineligible") {
    return capture.status;
  }
  return "none";
}
