import type { MemoryEntry } from "@do-soul/alaya-protocol";

/**
 * @anchor edge-auto-producer-llm-port
 *
 * Pair-classifier port for Phase B B-2: given a freshly materialized
 * memory and a same-dimension same-scope neighbor that already passed
 * the cheap eligibility filter, the garden LLM returns a relationship
 * verdict — supports / derives_from / null. The verdict is consumed by
 * EdgeAutoProducerService, which converts an accepted verdict into a
 * PENDING edge proposal carrying trigger_source = "llm_supports".
 *
 * Boundary discipline:
 * - This port is intentionally narrower than the supersedes /
 *   incompatible_with universe. ConflictDetectionService owns the
 *   contradicts / incompatible_with classifier; the supersedes writer
 *   lives in materialization-router via first-class candidate signal
 *   refs. Mixing them would re-collapse the KPI K3.2 per-trigger
 *   breakdown.
 * - The decision returned here is advisory only. The service applies a
 *   confidence floor (>= 0.85 per Phase B §B-2) and routes the result
 *   through graphEdgePort.proposeEdge, so the proposal queue and the
 *   reviewer / auto-accept policy remain the final gate.
 * - A `null` return value is the correct shape for "no relationship"
 *   and never raises a proposal. Returning `null` is also the correct
 *   adapter response on a malformed or low-confidence garden response —
 *   the service then falls back to the local heuristic for that
 *   neighbor.
 *
 * The adapter implementation lives in the daemon (apps/core-daemon/
 * src/edge-auto-producer-llm-adapter.ts) and walks the garden compute
 * local path; v0.3.11 §K4.5 forbids introducing a new cloud dependency
 * here.
 */
export interface EdgeAutoProducerLlmPort {
  classifyPair(input: {
    readonly newMemory: Readonly<MemoryEntry>;
    readonly neighbor: Readonly<MemoryEntry>;
  }): Promise<EdgeAutoProducerLlmDecision | null>;
}

export interface EdgeAutoProducerLlmDecision {
  readonly edgeType: "supports" | "derives_from";
  /** 0..1 — caller clamps and applies the §B-2 floor. */
  readonly confidence: number;
  readonly rationale: string;
}
