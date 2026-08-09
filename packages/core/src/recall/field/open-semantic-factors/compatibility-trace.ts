import type { OpenSemanticFactorFormationCapture } from
  "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import {
  materializeOpenSemanticFactorCompatibility,
  type OpenSemanticFactorCompatibilityReceipt
} from "./compatibility.js";

export const OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID =
  "open_semantic_factor_compatibility_trace_v1";
export const OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_LIMIT = 64;

export type OpenSemanticFactorCompatibilityTraceEntry = Readonly<{
  readonly evidence_id: string;
  readonly receipt: Readonly<OpenSemanticFactorCompatibilityReceipt>;
}>;

export type OpenSemanticFactorCompatibilityTrace = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID;
  readonly query_capture_digest: string;
  readonly observed_evidence_count: number;
  readonly evaluated_evidence_count: number;
  readonly truncated: boolean;
  readonly entries: readonly Readonly<OpenSemanticFactorCompatibilityTraceEntry>[];
  readonly trace_digest: RecallFieldDigest;
}>;

export function materializeOpenSemanticFactorCompatibilityTrace(params: Readonly<{
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
  readonly evidence_formations: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
}>): OpenSemanticFactorCompatibilityTrace {
  const observed = Object.entries(params.evidence_formations)
    .filter(([evidenceId]) => evidenceId.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const entries = Object.freeze(observed
    .slice(0, OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_LIMIT)
    .map(([evidenceId, evidenceCapture]) => Object.freeze({
      evidence_id: evidenceId,
      receipt: materializeOpenSemanticFactorCompatibility({
        evidence_capture: evidenceCapture,
        query_capture: params.query_capture
      })
    })));
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID,
    query_capture_digest: params.query_capture.capture_digest,
    observed_evidence_count: observed.length,
    evaluated_evidence_count: entries.length,
    truncated: observed.length > entries.length,
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
  const entriesValid = trace.entries.every((entry) => {
    const { receipt_digest: _receiptDigest, ...receiptBody } = entry.receipt;
    const unique = !evidenceIds.has(entry.evidence_id);
    evidenceIds.add(entry.evidence_id);
    return unique && entry.evidence_id.trim().length > 0 &&
      entry.receipt.query_capture_digest === trace.query_capture_digest &&
      digestRecallFieldIdentity(receiptBody) === entry.receipt.receipt_digest;
  });
  if (trace.schema_version !== 1 ||
      trace.operator_id !== OPEN_SEMANTIC_FACTOR_COMPATIBILITY_TRACE_OPERATOR_ID ||
      trace.evaluated_evidence_count !== trace.entries.length ||
      trace.observed_evidence_count < trace.evaluated_evidence_count ||
      trace.truncated !== (
        trace.observed_evidence_count > trace.evaluated_evidence_count
      ) || !entriesValid ||
      digestRecallFieldIdentity(body) !== trace.trace_digest) {
    throw new Error("open semantic factor compatibility trace contract mismatch");
  }
  return trace as OpenSemanticFactorCompatibilityTrace;
}
