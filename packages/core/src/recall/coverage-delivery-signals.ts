import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallFusionBreakdown } from "./recall-service-types.js";

// Shared delivery-coverage primitives consumed by evidence-set-optimizer.ts.
// Kept provider/policy-free so both the default optimizer and its admissibility
// gate read one copy.

export const COVERAGE_SELECTOR_ENV = "ALAYA_RECALL_COVERAGE_SELECTOR";
export const COVERAGE_POOL_K_ENV = "ALAYA_RECALL_COVERAGE_POOL_K";
export const COVERAGE_TARGET_K_ENV = "ALAYA_RECALL_COVERAGE_TARGET_K";
export const COVERAGE_MIN_SCORE_RATIO_ENV = "ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO";

export const DEFAULT_POOL_K = 30;
export const DEFAULT_TARGET_K = 5;
export const DEFAULT_MIN_SCORE_RATIO = 0.65;

export const NO_SESSION_KEY = "<no-session>";

export type DeliveryCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function readRatioEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function sessionKeyOf(entry: Readonly<MemoryEntry>): string {
  return entry.surface_id ?? entry.run_id ?? NO_SESSION_KEY;
}

export function dateBucketOf(entry: Readonly<MemoryEntry>): string | null {
  const created = entry.created_at;
  return typeof created === "string" && created.length >= 10 ? created.slice(0, 10) : null;
}

// A non-lexical stream hit (semantic / structural / adjacency) is the buried
// gold coverage promotion exists to rescue, so it bypasses the score gate. A
// path-suppressed candidate is excluded from the graph/path streams it was
// suppressed *for*, so the rescue cannot readmit it on its demoted reach.
export function hasPromotableStreamHit(
  fusion: Readonly<RecallFusionBreakdown>,
  suppressed = false
): boolean {
  const ranks = fusion.per_stream_rank;
  return (
    ranks.embedding_similarity !== null ||
    ranks.evidence_fts !== null ||
    ranks.evidence_structural_agreement !== null ||
    ranks.source_proximity !== null ||
    (!suppressed && (ranks.path_expansion !== null || ranks.graph_expansion !== null))
  );
}

export function isAdmissible(
  fusion: Readonly<RecallFusionBreakdown>,
  naturalRank: number,
  targetK: number,
  headScore: number,
  minScoreRatio: number,
  suppressed = false
): boolean {
  if (naturalRank <= targetK) return true;
  const base = headScore > 0 ? fusion.fused_score / headScore : 0;
  if (base >= minScoreRatio) return true;
  return hasPromotableStreamHit(fusion, suppressed);
}

export function resolveCoverageTargetK(maxEntries: number): number {
  return Math.min(readPositiveIntEnv(COVERAGE_TARGET_K_ENV, DEFAULT_TARGET_K), maxEntries);
}

export function resolveCoveragePoolK(orderedLength: number, targetK: number): number {
  return Math.min(orderedLength, Math.max(readPositiveIntEnv(COVERAGE_POOL_K_ENV, DEFAULT_POOL_K), targetK));
}

export function appendRemainder<T>(
  ordered: readonly T[],
  selected: readonly T[],
  selectedSet: ReadonlySet<T>
): readonly T[] {
  const remainder = ordered.filter((candidate) => !selectedSet.has(candidate));
  return Object.freeze([...selected, ...remainder]);
}
