import type { CanonicalQueryCompilationV1 } from "./compilation.js";
import type { CanonicalQueryV1 } from "./types.js";

export const QUERY_PROOF_COMPILE_DISPOSITION_OPERATOR_ID =
  "query_proof_compile_disposition_v1" as const;

export type CompileDispositionCountsV1 = Readonly<
  Record<CanonicalQueryCompilationV1["compile_status"], number>
>;

export type CompileDispositionObservationV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_COMPILE_DISPOSITION_OPERATOR_ID;
  readonly observation_status: "observed";
  readonly silent_fallback_instrument: "absent";
  readonly silent_empty_demand_fallbacks: number;
  readonly counts: CompileDispositionCountsV1;
  readonly total: number;
}>;

export function silentEmptyDemandFallbackCount(
  compilation: CanonicalQueryCompilationV1
): number {
  return compilation.hypotheses.filter((query) => isSilentEmptyDemand(query, compilation))
    .length;
}

export function observeCompileDisposition(
  compilations: readonly CanonicalQueryCompilationV1[]
): CompileDispositionObservationV1 {
  const counts: Record<CanonicalQueryCompilationV1["compile_status"], number> = {
    certified_program: 0,
    partial_program: 0,
    unsupported: 0
  };
  let silent_empty_demand_fallbacks = 0;
  for (const compilation of compilations) {
    counts[compilation.compile_status] += 1;
    silent_empty_demand_fallbacks += silentEmptyDemandFallbackCount(compilation);
  }
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_COMPILE_DISPOSITION_OPERATOR_ID,
    observation_status: "observed" as const,
    silent_fallback_instrument: "absent" as const,
    silent_empty_demand_fallbacks,
    counts: Object.freeze(counts),
    total: compilations.length
  });
}

function isSilentEmptyDemand(
  query: CanonicalQueryV1,
  compilation: CanonicalQueryCompilationV1
): boolean {
  return query.predicates.length === 0 && compilation.holes.length === 0;
}
