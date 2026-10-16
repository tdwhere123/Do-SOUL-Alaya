import { SourceSemanticWorkerResultSchema,
  sourceSemanticUndeliveredConclusion, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";

type Reason = Extract<SourceSemanticWorkerResult, { kind: "reason" }>;

/** Fit the actual consumer envelope; never retain conclusions without their complete premises. */
export function finalizeSourceSemanticReason(result: Reason, limit: number,
  encode: (value: Reason) => string = JSON.stringify): Reason {
  // Producers already captured canonical compact execution. Fitting must not expand/repack it.
  const full = result;
  if (Buffer.byteLength(encode(full), "utf8") <= limit) return full;
  if (full.result !== undefined) {
    const limited = SourceSemanticWorkerResultSchema.parse({ kind: "reason", execution: full.execution,
      ...sourceSemanticUndeliveredConclusion({ ...full.result,
        ...(full.result.query_gaps !== undefined || full.query === undefined ? {} : { query_gaps: full.query.gaps }) }),
      source_disclosure: full.source_disclosure,
      coverage: { ...full.coverage, payload: "truncated" }, work: full.work
    }) as Reason;
    if (Buffer.byteLength(encode(limited), "utf8") <= limit) return limited;
  }
  throw new CoreError("VALIDATION", "output budget cannot retain interpretation qualifiers", { details: { work: full.work } });
}
