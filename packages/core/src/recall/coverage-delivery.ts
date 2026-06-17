import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type {
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "./recall-service-types.js";

// Coverage-aware top-K selection. Where applySessionCoverageRerank only reorders
// inside the delivered window (and no-ops when that window is single-session),
// this rewrites the top-K from a wider pool (top-M) so a second session / source
// / evidence / date that the natural ranking buried past K can still reach K.
// Default-off; natural rank1 is always kept (R@1 hard invariant).

const COVERAGE_SELECTOR_ENV = "ALAYA_RECALL_COVERAGE_SELECTOR";
const COVERAGE_POOL_K_ENV = "ALAYA_RECALL_COVERAGE_POOL_K";
const COVERAGE_TARGET_K_ENV = "ALAYA_RECALL_COVERAGE_TARGET_K";
const COVERAGE_MIN_SCORE_RATIO_ENV = "ALAYA_RECALL_COVERAGE_MIN_SCORE_RATIO";

const DEFAULT_POOL_K = 30;
const DEFAULT_TARGET_K = 5;
const DEFAULT_MIN_SCORE_RATIO = 0.65;

const NO_SESSION_KEY = "<no-session>";

type CoverageCandidate = Readonly<{
  readonly entry: MemoryEntry;
  readonly fusion: RecallFusionBreakdown;
}>;

interface CoverageState {
  readonly sessions: Set<string>;
  readonly sourceCohorts: Set<string>;
  readonly evidenceRefs: Set<string>;
  readonly dateBuckets: Set<string>;
  readonly dimensions: Set<string>;
}

function coverageSelectorEnabled(): boolean {
  const raw = process.env[COVERAGE_SELECTOR_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function readRatioEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sessionKeyOf(entry: MemoryEntry): string {
  return entry.surface_id ?? entry.run_id ?? NO_SESSION_KEY;
}

function dateBucketOf(entry: MemoryEntry): string | null {
  const created = entry.created_at;
  return typeof created === "string" && created.length >= 10 ? created.slice(0, 10) : null;
}

// A candidate carrying a non-lexical stream hit (semantic / structural /
// adjacency) is the kind of buried gold coverage promotion exists to rescue, so
// it bypasses the score gate even below the ratio floor.
function hasPromotableStreamHit(fusion: RecallFusionBreakdown): boolean {
  const ranks = fusion.per_stream_rank;
  return (
    ranks.embedding_similarity !== null ||
    ranks.path_expansion !== null ||
    ranks.graph_expansion !== null ||
    ranks.evidence_fts !== null ||
    ranks.evidence_structural_agreement !== null ||
    ranks.source_proximity !== null
  );
}

function markCovered(
  candidate: CoverageCandidate,
  covered: CoverageState,
  sourceCohortKey: string | null
): void {
  covered.sessions.add(sessionKeyOf(candidate.entry));
  if (sourceCohortKey !== null) covered.sourceCohorts.add(sourceCohortKey);
  for (const ref of candidate.entry.evidence_refs) covered.evidenceRefs.add(ref);
  const bucket = dateBucketOf(candidate.entry);
  if (bucket !== null) covered.dateBuckets.add(bucket);
  covered.dimensions.add(candidate.entry.dimension);
}

function coverageUtility(
  candidate: CoverageCandidate,
  headScore: number,
  covered: CoverageState,
  sourceCohortKey: string | null
): number {
  const base = headScore > 0 ? candidate.fusion.fused_score / headScore : 0;
  const entry = candidate.entry;
  const sameSession = covered.sessions.has(sessionKeyOf(entry));
  const addsEvidence = entry.evidence_refs.some((ref) => !covered.evidenceRefs.has(ref));
  const bucket = dateBucketOf(entry);

  let bonus = 0;
  if (!sameSession) bonus += 0.1;
  if (sourceCohortKey !== null && !covered.sourceCohorts.has(sourceCohortKey)) bonus += 0.06;
  if (addsEvidence) bonus += 0.05;
  if (bucket !== null && !covered.dateBuckets.has(bucket)) bonus += 0.03;
  if (!covered.dimensions.has(entry.dimension)) bonus += 0.02;

  let penalty = 0;
  if (sameSession && !addsEvidence) penalty += 0.06;
  if (sourceCohortKey !== null && covered.sourceCohorts.has(sourceCohortKey)) penalty += 0.04;

  return base + bonus - penalty;
}

function isAdmissible(
  candidate: CoverageCandidate,
  naturalRank: number,
  targetK: number,
  headScore: number,
  minScoreRatio: number
): boolean {
  if (naturalRank <= targetK) return true;
  const base = headScore > 0 ? candidate.fusion.fused_score / headScore : 0;
  if (base >= minScoreRatio) return true;
  return hasPromotableStreamHit(candidate.fusion);
}

export function applyCoverageDeliverySelection<T extends CoverageCandidate>(
  ordered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  if (!coverageSelectorEnabled() || maxEntries <= 1 || ordered.length <= 1) {
    return ordered;
  }
  const targetK = Math.min(readPositiveIntEnv(COVERAGE_TARGET_K_ENV, DEFAULT_TARGET_K), maxEntries);
  if (targetK <= 1) {
    return ordered;
  }
  const poolK = Math.min(ordered.length, Math.max(readPositiveIntEnv(COVERAGE_POOL_K_ENV, DEFAULT_POOL_K), targetK));
  const minScoreRatio = readRatioEnv(COVERAGE_MIN_SCORE_RATIO_ENV, DEFAULT_MIN_SCORE_RATIO);
  const pool = ordered.slice(0, poolK);
  const head = pool[0];
  if (head === undefined) {
    return ordered;
  }
  const headScore = head.fusion.fused_score;
  const cohortOf = (candidate: T): string | null =>
    supplementaryData.sourceCohortKeys[candidate.entry.object_id] ?? null;

  const covered: CoverageState = {
    sessions: new Set<string>(),
    sourceCohorts: new Set<string>(),
    evidenceRefs: new Set<string>(),
    dateBuckets: new Set<string>(),
    dimensions: new Set<string>()
  };
  const selected: T[] = [head];
  const selectedSet = new Set<T>([head]);
  markCovered(head, covered, cohortOf(head));

  while (selected.length < targetK) {
    let best: T | undefined;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index]!;
      if (selectedSet.has(candidate)) continue;
      if (!isAdmissible(candidate, index + 1, targetK, headScore, minScoreRatio)) continue;
      const utility = coverageUtility(candidate, headScore, covered, cohortOf(candidate));
      if (utility > bestUtility) {
        bestUtility = utility;
        best = candidate;
      }
    }
    if (best === undefined) break;
    selected.push(best);
    selectedSet.add(best);
    markCovered(best, covered, cohortOf(best));
  }

  const remainder = ordered.filter((candidate) => !selectedSet.has(candidate));
  return Object.freeze([...selected, ...remainder]);
}
