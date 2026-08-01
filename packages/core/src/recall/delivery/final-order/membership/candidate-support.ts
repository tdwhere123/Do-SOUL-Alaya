import type { FineAssessmentCandidate } from
  "../../fine-assessment-selection/types.js";
import { isFinitePositiveRank } from "./path-certificate.js";

type EvidenceCandidate = Readonly<{
  readonly sourceCandidate: FineAssessmentCandidate;
}>;

export function directEvidenceDominates<T extends EvidenceCandidate>(
  incumbent: T,
  substitute: T
): boolean {
  const incumbentRanks = directEvidenceFamilyRanks(incumbent);
  const substituteRanks = directEvidenceFamilyRanks(substitute);
  let observedFamilies = 0;
  let strictlyBetter = false;
  for (let index = 0; index < incumbentRanks.length; index += 1) {
    const incumbentRank = incumbentRanks[index]!;
    const substituteRank = substituteRanks[index]!;
    if (incumbentRank === null && substituteRank === null) continue;
    if (incumbentRank === null) return false;
    observedFamilies += 1;
    if (substituteRank === null || incumbentRank < substituteRank) {
      strictlyBetter = true;
      continue;
    }
    if (incumbentRank > substituteRank) return false;
  }
  return observedFamilies >= 2 && strictlyBetter;
}

export function membershipSessionKey(
  candidate: FineAssessmentCandidate
): string | null {
  const value = candidate.entry.surface_id ?? candidate.entry.run_id;
  return isNonEmpty(value) ? value.trim() : null;
}

function directEvidenceFamilyRanks<T extends EvidenceCandidate>(
  candidate: T
): readonly (number | null)[] {
  const ranks = candidate.sourceCandidate.fusion.per_stream_rank;
  return Object.freeze([
    bestFiniteRank(ranks.lexical_fts, ranks.trigram_fts),
    bestFiniteRank(ranks.evidence_fts, ranks.evidence_structural_agreement),
    bestFiniteRank(ranks.source_proximity, ranks.source_evidence_agreement)
  ]);
}

function bestFiniteRank(...ranks: readonly (number | null)[]): number | null {
  const finite = ranks.filter((rank): rank is number => isFinitePositiveRank(rank));
  return finite.length === 0 ? null : Math.min(...finite);
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
