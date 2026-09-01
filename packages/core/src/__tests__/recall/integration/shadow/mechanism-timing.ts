export const QUERY_PROOF_SHADOW_MECHANISM_TIMING_OPERATOR_ID =
  "query_proof_shadow_mechanism_timing_v1" as const;

export type ShadowMechanismTimingReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_SHADOW_MECHANISM_TIMING_OPERATOR_ID;
  readonly mechanism_id: string;
  readonly observation_status: "observed";
  readonly evidence_class: "mechanism_timing";
  readonly elapsed_ms: number;
}>;

export function observeShadowMechanismTiming<T>(
  params: Readonly<{ readonly mechanism_id: string; readonly run: () => T }>
): Readonly<{ readonly value: T; readonly timing: ShadowMechanismTimingReceiptV1 }> {
  const started = performance.now();
  const value = params.run();
  const elapsed_ms = performance.now() - started;
  if (!Number.isFinite(elapsed_ms) || elapsed_ms < 0) {
    throw new Error("shadow mechanism timing must be a finite non-negative duration");
  }
  return Object.freeze({
    value,
    timing: Object.freeze({
      schema_version: 1 as const,
      operator_id: QUERY_PROOF_SHADOW_MECHANISM_TIMING_OPERATOR_ID,
      mechanism_id: params.mechanism_id,
      observation_status: "observed" as const,
      evidence_class: "mechanism_timing" as const,
      elapsed_ms
    })
  });
}
