// Compose-then-rank activation assembly: groups recall candidates into entity-keyed units before ranking.

import type { FineAssessmentCandidate } from "./fine-assessment-selection.js";
import type { RecallSupplementaryData } from "./recall-service-types.js";
import { compareFusedRecallCandidates } from "./fusion-delivery.js";
import { buildRecallCandidateDedupeKey } from "./recall-service-helpers.js";
import { clamp01 } from "../shared/clamp.js";
import {
  DEFAULT_ENTITY_GROUP_CAP,
  groupCandidatesByEntity,
  type EntityCandidate
} from "./entity-expansion.js";

function flagEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}

// Master switch (default off → legacy flat path stays byte-identical).
export function composeRecallEnabled(): boolean {
  return flagEnabled("ALAYA_RECALL_COMPOSE");
}

export interface ActivationCandidate {
  readonly key: string | null;
  readonly members: readonly string[];
  readonly score: number;
}

// Bounded coverage bonus: λ caps the additive lift so a strong singleton (bonus 0) is never
// flipped by a weak large group, and saturation maps "distinct sessions beyond the first" into [0,1].
export const COMPOSE_COVERAGE_LAMBDA = 0.05;
export const COMPOSE_COVERAGE_SATURATION = 4;

interface ComposedActivationUnit {
  readonly members: readonly FineAssessmentCandidate[];
  readonly score: number;
}

function groupSessionKey(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
): string {
  return (
    supplementaryData.sourceCohortKeys[candidate.entry.object_id] ??
    candidate.entry.surface_id ??
    candidate.entry.run_id ??
    "<no-session>"
  );
}

// Diversity-of-sessions across members, normalized to [0,1]; a singleton scores 0 so it degenerates
// to its own object score (single-gold safe).
function groupCoverageBonus(
  members: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData
): number {
  if (members.length < 2) return 0;
  const sessions = new Set<string>();
  for (const member of members) sessions.add(groupSessionKey(member, supplementaryData));
  return clamp01((sessions.size - 1) / COMPOSE_COVERAGE_SATURATION);
}

// Group score = strongest member's fused_score + bounded coverage lift (never the member sum).
function composeGroupScore(
  members: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData
): number {
  const best = members[0]?.fusion.fused_score ?? 0;
  return best + COMPOSE_COVERAGE_LAMBDA * groupCoverageBonus(members, supplementaryData);
}

// Compose-then-rank delivery: seed by fused order, group same-canonical-entity members, rank the
// composed units by group score (tie-break by best member's comparator), then deliver the raw members
// (navigator) in group-rank order. Returns the full reordered list; downstream slices to max_entries.
export function composeAndOrderByEntity(
  scoredCandidates: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): FineAssessmentCandidate[] {
  if (scoredCandidates.length === 0) return [];
  const seeds = [...scoredCandidates].sort(compareFusedRecallCandidates);
  const byKey = new Map<string, FineAssessmentCandidate>();
  const entityInputs: EntityCandidate[] = [];
  for (const seed of seeds) {
    const key = buildRecallCandidateDedupeKey(seed);
    if (byKey.has(key)) continue;
    byKey.set(key, seed);
    entityInputs.push({ objectId: key, canonicalEntities: seed.entry.canonical_entities });
  }
  // Cap each entity's contribution to the delivery window (≥ default); overflow is recovered at the tail below.
  const groupCap = Math.max(maxEntries, DEFAULT_ENTITY_GROUP_CAP);
  const units: ComposedActivationUnit[] = groupCandidatesByEntity(entityInputs, { cap: groupCap }).map(
    (group) => {
      const members = group.memberObjectIds
        .map((memberKey) => byKey.get(memberKey)!)
        .sort(compareFusedRecallCandidates);
      return { members, score: composeGroupScore(members, supplementaryData) };
    }
  );
  units.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    return compareFusedRecallCandidates(left.members[0], right.members[0]);
  });
  const delivered: FineAssessmentCandidate[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    for (const member of unit.members) {
      const key = buildRecallCandidateDedupeKey(member);
      if (seen.has(key)) continue;
      seen.add(key);
      delivered.push(member);
    }
  }
  // Recover any cap-overflow / ungrouped seed in fused order so the result is a full permutation.
  for (const seed of seeds) {
    const key = buildRecallCandidateDedupeKey(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    delivered.push(seed);
  }
  return delivered;
}
