import type {
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
  RecallSupplementaryData} from "./recall-service-types.js";
import { coverageReorderGateOpen } from "./evidence-set-optimizer.js";

type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

const SESSION_COVERAGE_BAND_ENV = "ALAYA_RECALL_SESSION_COVERAGE_BAND";
const DEFAULT_SESSION_COVERAGE_BAND = 0.1;

// Fraction of the head fused_score within which a lower-ranked, not-yet-represented session may be promoted ahead of it; 0 disables. Env-tunable.
function resolveSessionCoverageBand(): number {
  const raw = process.env[SESSION_COVERAGE_BAND_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SESSION_COVERAGE_BAND;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SESSION_COVERAGE_BAND;
}

function sessionCoverageKey(
  candidate: Readonly<FusedRecallCandidateInput>
): string {
  return candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>";
}

// invariant: reorders only inside the top-K window — the delivered set is unchanged, only order. An already-represented session yields to the next not-yet-represented session within `band`; strong head hits are never demoted. Gated by the same multi-fact condition as the evidence-set optimizer; no-op on a single-session window.
export function applySessionCoverageRerank<T extends FusedRecallCandidateInput>(
  ordered: readonly T[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): readonly T[] {
  if (!coverageReorderGateOpen(ordered, supplementaryData, maxEntries)) {
    return ordered;
  }
  const band = resolveSessionCoverageBand();
  if (band <= 0 || maxEntries <= 1 || ordered.length <= 1) {
    return ordered;
  }
  const windowSize = Math.min(maxEntries, ordered.length);
  const window = ordered.slice(0, windowSize);
  if (new Set(window.map(sessionCoverageKey)).size <= 1) {
    return ordered;
  }
  const remaining = [...window];
  const rest = ordered.slice(windowSize);
  const result: T[] = [];
  const represented = new Set<string>();
  while (remaining.length > 0) {
    const head = remaining[0];
    if (head === undefined) {
      break;
    }
    const headKey = sessionCoverageKey(head);
    if (represented.has(headKey)) {
      const headScore = head.fusion.fused_score;
      const tolerance = band * Math.abs(headScore);
      const altIndex = remaining.findIndex(
        (candidate, index) =>
          index > 0 &&
          !represented.has(sessionCoverageKey(candidate)) &&
          headScore - candidate.fusion.fused_score <= tolerance
      );
      if (altIndex !== -1) {
        const alt = remaining[altIndex];
        if (alt !== undefined) {
          remaining.splice(altIndex, 1);
          result.push(alt);
          represented.add(sessionCoverageKey(alt));
          continue;
        }
      }
    }
    result.push(head);
    represented.add(headKey);
    remaining.shift();
  }
  return Object.freeze([...result, ...rest]);
}
