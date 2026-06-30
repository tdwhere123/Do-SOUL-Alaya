// Compose-then-rank activation assembly: groups recall candidates into entity-keyed units before ranking.

import type { FineAssessmentCandidate } from "./fine-assessment-selection.js";
import type { RecallSupplementaryData } from "./recall-service-types.js";
import { compareFusedRecallCandidates } from "./fusion-delivery.js";
import { buildRecallCandidateDedupeKey, normalizeGraphSupport } from "./recall-service-helpers.js";
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

// Core-only composed unit (protocol owns a different ActivationCandidate). Members are the raw
// FineAssessmentCandidates delivered as a navigator; key/score expose the entity group.
export interface ComposedActivationCandidate {
  readonly key: string | null;
  readonly members: readonly FineAssessmentCandidate[];
  readonly score: number;
}

// Bounded coverage bonus: λ caps the additive lift so a strong singleton (bonus 0) is never
// flipped by a weak large group, and saturation maps "distinct sessions beyond the first" into [0,1].
export const COMPOSE_COVERAGE_LAMBDA = 0.05;
export const COMPOSE_COVERAGE_SATURATION = 4;

// Bounded evidence gain g(R_E)=1+β·R_E (g(0)=1) on the group score; β small so evidence never dominates
// the object base. Net effect is measured by bench (Card E) and β can be tuned to 0.
export const COMPOSE_EVIDENCE_BETA = 0.1;

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

// Evidence axis R_E for the group = strongest member's query-orthogonal inbound graph-support tally,
// the same conformant evidence signal (normalizeGraphSupport over graphSupportCounts).
function groupEvidenceSupport(
  members: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData
): number {
  let best = 0;
  for (const member of members) {
    const support = normalizeGraphSupport(supplementaryData.graphSupportCounts[member.entry.object_id] ?? 0);
    if (support > best) best = support;
  }
  return best;
}

// Group score = strongest member's fused_score + bounded coverage lift, then the bounded evidence gain
// (never the member sum, so a large group cannot win on size alone).
function composeGroupScore(
  members: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData
): number {
  const base = members[0]?.fusion.fused_score ?? 0;
  const withCoverage = base + COMPOSE_COVERAGE_LAMBDA * groupCoverageBonus(members, supplementaryData);
  return withCoverage * (1 + COMPOSE_EVIDENCE_BETA * groupEvidenceSupport(members, supplementaryData));
}

function composeUnits(
  entityInputs: readonly EntityCandidate[],
  byKey: ReadonlyMap<string, FineAssessmentCandidate>,
  supplementaryData: RecallSupplementaryData,
  groupCap: number
): ComposedActivationCandidate[] {
  const units: ComposedActivationCandidate[] = groupCandidatesByEntity(entityInputs, { cap: groupCap }).map(
    (group) => {
      const members = group.memberObjectIds
        .map((memberKey) => byKey.get(memberKey)!)
        .sort(compareFusedRecallCandidates);
      return { key: group.key, members, score: composeGroupScore(members, supplementaryData) };
    }
  );
  units.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    return compareFusedRecallCandidates(left.members[0], right.members[0]);
  });
  return units;
}

// Deliver raw members (navigator) in group-rank order, then recover any cap-overflow / ungrouped seed
// in fused order so the result is a full permutation of the input.
function deliverByUnitRank(
  units: readonly ComposedActivationCandidate[],
  seeds: readonly FineAssessmentCandidate[]
): FineAssessmentCandidate[] {
  const delivered: FineAssessmentCandidate[] = [];
  const seen = new Set<string>();
  const push = (member: FineAssessmentCandidate): void => {
    const key = buildRecallCandidateDedupeKey(member);
    if (seen.has(key)) return;
    seen.add(key);
    delivered.push(member);
  };
  for (const unit of units) for (const member of unit.members) push(member);
  for (const seed of seeds) push(seed);
  return delivered;
}

// Governance arbitration: a member whose superseded_by points to a candidate present in this compose
// input is stale; demote it below all live members (stable, full permutation preserved) so it cannot
// ride a group to the top. ConflictMatrix edges are a future extension.
function demoteSupersededToTail(
  delivered: readonly FineAssessmentCandidate[],
  candidates: readonly FineAssessmentCandidate[]
): FineAssessmentCandidate[] {
  const presentObjectIds = new Set(candidates.map((candidate) => candidate.entry.object_id));
  const live: FineAssessmentCandidate[] = [];
  const stale: FineAssessmentCandidate[] = [];
  for (const member of delivered) {
    const supersededBy = member.entry.superseded_by;
    const isStale = supersededBy != null && presentObjectIds.has(supersededBy);
    (isStale ? stale : live).push(member);
  }
  return [...live, ...stale];
}

// Compose-then-rank delivery: seed by fused order → group same-canonical-entity members →
// supportByEvidence(g(R_E)) → arbitrateByGovernance(superseded_by) → rank units by group score
// (tie-break by best member's comparator) → deliver raw members. Returns the full reordered list;
// downstream slices to max_entries.
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
  // Cap each entity's contribution to the delivery window (≥ default); overflow recovers at the tail.
  const groupCap = Math.max(maxEntries, DEFAULT_ENTITY_GROUP_CAP);
  const units = composeUnits(entityInputs, byKey, supplementaryData, groupCap);
  return demoteSupersededToTail(deliverByUnitRank(units, seeds), scoredCandidates);
}
