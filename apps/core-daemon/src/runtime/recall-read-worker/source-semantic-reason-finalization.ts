import { SourceSemanticWorkerResultSchema, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";

type Reason = Extract<SourceSemanticWorkerResult, { kind: "reason" }>;

/** Fit the actual consumer envelope; never retain conclusions without their complete premises. */
export function finalizeSourceSemanticReason(result: Reason, limit: number,
  encode: (value: Reason) => string = JSON.stringify): Reason {
  if (Buffer.byteLength(encode(result), "utf8") <= limit) return result;
  const reason = result.result;
  const limited = SourceSemanticWorkerResultSchema.parse({ kind: "reason",
    source_disclosure: result.source_disclosure,
    result: { contract: reason.contract, conditional_computation_id: reason.conditional_computation_id,
      source_interpretation_id: reason.source_interpretation_id, query_semantics_id: reason.query_semantics_id,
      semantic_correspondence_id: reason.semantic_correspondence_id,
      semantic_status: reason.semantic_status, conclusion_scope: reason.conclusion_scope, world_claim: reason.world_claim,
      outcome: reason.outcome.status === "preparation_required" || reason.outcome.status === "invalid"
        ? reason.outcome : { status: "truncated" }, consumed_leaves: [] },
    coverage: { ...result.coverage, payload: "truncated" }, work: result.work
  }) as Reason;
  if (Buffer.byteLength(encode(limited), "utf8") <= limit) return limited;
  if (reason.outcome.status !== "preparation_required" && reason.outcome.status !== "invalid") {
    throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers", { details: { work: result.work } });
  }
  const { conditional_computation_id: _computation, source_interpretation_id: _interpretation,
    query_semantics_id: _query, semantic_correspondence_id: _correspondence, ...qualifiers } = limited.result;
  const minimal: Reason = { ...limited, result: qualifiers };
  if (Buffer.byteLength(encode(minimal), "utf8") > limit) {
    throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers", { details: { work: result.work } });
  }
  return minimal;
}
