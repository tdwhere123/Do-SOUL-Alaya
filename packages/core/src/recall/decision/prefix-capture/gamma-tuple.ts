import { compareText } from "../../../shared/compare-text.js";
import {
  lowerFrontierNoveltyAdmission,
  obligationIdentity,
  type ShadowCoordinateAvailability,
  type ShadowGammaTuple,
  type ShadowObligationKey,
  type ShadowSetUtilityInput,
  type ShadowWitnessStanding
} from "./capture.js";
import { freezeShadow } from "./envelope.js";

export type ShadowSelectedSet = Readonly<{
  readonly best_cover: ReadonlyMap<string, number>;
  readonly value_pairs: ReadonlySet<string>;
  readonly content_ids: ReadonlySet<string>;
}>;

export type ShadowCoverRead = Readonly<{
  readonly cover: number;
  readonly availability: ShadowCoordinateAvailability;
  readonly evaluated: boolean;
}>;

export type ShadowNoveltyAbsence = Readonly<{
  readonly witness: "facility" | "values" | "evidence_identity";
  readonly core_candidate_key: string;
  readonly basis: string;
}>;

export type ShadowNoveltyAdmit = Readonly<{
  readonly admitted: boolean;
  readonly facility_keys: readonly string[];
  readonly value_pairs: readonly string[];
  readonly content_ids: readonly string[];
  readonly core_absence: readonly ShadowNoveltyAbsence[];
}>;

type ValuePair = Readonly<{ readonly id: string; readonly label: string }>;

export function emptySelectedSet(): ShadowSelectedSet {
  return {
    best_cover: new Map(),
    value_pairs: new Set(),
    content_ids: new Set()
  };
}

export function obligationKeyLabel(key: ShadowObligationKey): string {
  return `${key.kind}:${key.value}`;
}

export function obligationUniverseFrom(
  candidates: readonly ShadowSetUtilityInput[]
): readonly ShadowObligationKey[] {
  const seen = new Set<string>();
  const keys: ShadowObligationKey[] = [];
  for (const candidate of candidates) {
    for (const obligation of candidate.obligations) {
      const id = obligationIdentity(obligation.key);
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(obligation.key);
    }
  }
  return Object.freeze(keys);
}

export function readObligationCover(
  candidate: ShadowSetUtilityInput,
  atom: ShadowObligationKey
): ShadowCoverRead {
  const id = obligationIdentity(atom);
  const obligation = candidate.obligations.find(
    (entry) => obligationIdentity(entry.key) === id
  );
  if (obligation === undefined) {
    return freezeShadow({
      cover: 0,
      availability: "not_observed" as const,
      evaluated: false
    });
  }
  return freezeShadow({
    cover: numericCover(candidate, obligation.availability, obligation.cover,
      obligation.evaluated, id),
    availability: obligation.availability,
    evaluated: obligation.evaluated
  });
}

export function computeGammaTuple(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet,
  universe: readonly ShadowObligationKey[]
): ShadowGammaTuple {
  return freezeShadow({
    unscaled_remainder: facilityRemainder(candidate, selected, universe),
    Values_v: valuesIncrement(candidate, selected),
    evidence_novelty_redundancy: evidenceBit(candidate, selected)
  });
}

export function compareGammaTuple(
  left: ShadowGammaTuple,
  right: ShadowGammaTuple
): number {
  if (left.unscaled_remainder !== right.unscaled_remainder) {
    return left.unscaled_remainder > right.unscaled_remainder ? 1 : -1;
  }
  if (left.Values_v !== right.Values_v) {
    return left.Values_v > right.Values_v ? 1 : -1;
  }
  if (left.evidence_novelty_redundancy !== right.evidence_novelty_redundancy) {
    return left.evidence_novelty_redundancy > right.evidence_novelty_redundancy
      ? 1
      : -1;
  }
  return 0;
}

export function acceptCandidate(
  selected: ShadowSelectedSet,
  candidate: ShadowSetUtilityInput,
  universe: readonly ShadowObligationKey[]
): ShadowSelectedSet {
  const best = new Map(selected.best_cover);
  for (const atom of universe) {
    const read = readObligationCover(candidate, atom);
    if (!coverCountsTowardBest(read.availability)) continue;
    const id = obligationIdentity(atom);
    const previous = best.get(id) ?? 0;
    if (read.cover > previous) best.set(id, read.cover);
  }
  const valuePairs = new Set(selected.value_pairs);
  for (const pair of composedPairs(candidate)) valuePairs.add(pair.id);
  const contentIds = new Set(selected.content_ids);
  if (candidate.cid.status === "available") contentIds.add(candidate.cid.cid);
  return { best_cover: best, value_pairs: valuePairs, content_ids: contentIds };
}

export function evaluateOtherwiseUnavailableNovelty(
  candidate: ShadowSetUtilityInput,
  core: readonly ShadowSetUtilityInput[],
  selected: ShadowSelectedSet,
  universe: readonly ShadowObligationKey[]
): ShadowNoveltyAdmit {
  const facility = admitFacility(candidate, core, selected, universe);
  const values = admitValues(candidate, core, selected);
  const evidence = admitEvidence(candidate, core, selected);
  const facilityKeys = sortedFreeze(facility.keys);
  const valuePairs = sortedFreeze(values.keys);
  const contentIds = sortedFreeze(evidence.keys);
  return freezeShadow({
    admitted: facilityKeys.length + valuePairs.length + contentIds.length > 0,
    facility_keys: facilityKeys,
    value_pairs: valuePairs,
    content_ids: contentIds,
    core_absence: Object.freeze(
      [...facility.absence, ...values.absence, ...evidence.absence]
        .sort(compareAbsence)
    )
  });
}

function numericCover(
  candidate: ShadowSetUtilityInput,
  availability: ShadowCoordinateAvailability,
  receiptCover: number,
  evaluated: boolean,
  obligationId: string
): number {
  if (availability === "unavailable" || availability === "not_observed") {
    return 0;
  }
  let matchMax = 0;
  let hasMatch = false;
  for (const match of candidate.matches) {
    if (obligationIdentity(match.obligation) !== obligationId) continue;
    hasMatch = true;
    if (match.match_strength > matchMax) matchMax = match.match_strength;
  }
  if (hasMatch) return matchMax;
  return evaluated ? receiptCover : 0;
}

function coverCountsTowardBest(availability: ShadowCoordinateAvailability): boolean {
  return availability !== "unavailable" && availability !== "not_observed";
}

function facilityRemainder(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet,
  universe: readonly ShadowObligationKey[]
): number {
  if (universe.length === 0) return 0;
  let total = 0;
  for (const atom of universe) {
    total += remainderOn(candidate, selected, atom);
  }
  return total;
}

function remainderOn(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet,
  atom: ShadowObligationKey
): number {
  const read = readObligationCover(candidate, atom);
  if (!coverCountsTowardBest(read.availability)) return 0;
  const best = selected.best_cover.get(obligationIdentity(atom)) ?? 0;
  return Math.max(0, read.cover - best);
}

function valuesIncrement(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet
): number {
  let count = 0;
  for (const pair of composedPairs(candidate)) {
    if (!selected.value_pairs.has(pair.id)) count += 1;
  }
  return count;
}

function evidenceBit(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet
): 0 | 1 {
  if (candidate.cid.status !== "available") return 0;
  return selected.content_ids.has(candidate.cid.cid) ? 0 : 1;
}

function composedPairs(candidate: ShadowSetUtilityInput): readonly ValuePair[] {
  if (candidate.values.status !== "composed") return [];
  const seen = new Set<string>();
  const pairs: ValuePair[] = [];
  for (const pair of candidate.values.values) {
    const id = `${pair.variable_id}\u0000${pair.semantic_identity}`;
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push({ id, label: `${pair.variable_id}:${pair.semantic_identity}` });
  }
  return pairs;
}

function admitFacility(
  candidate: ShadowSetUtilityInput,
  core: readonly ShadowSetUtilityInput[],
  selected: ShadowSelectedSet,
  universe: readonly ShadowObligationKey[]
): { keys: string[]; absence: ShadowNoveltyAbsence[] } {
  const keys: string[] = [];
  const absence: ShadowNoveltyAbsence[] = [];
  for (const atom of universe) {
    const label = obligationKeyLabel(atom);
    if (!admitsWitness(
      facilityStanding(candidate, selected, atom),
      core.map((member) => facilityStanding(member, selected, atom))
    )) continue;
    keys.push(label);
    pushAbsence(absence, core, "facility", `known rem=0 for ${label}`);
  }
  return { keys, absence };
}

function admitValues(
  candidate: ShadowSetUtilityInput,
  core: readonly ShadowSetUtilityInput[],
  selected: ShadowSelectedSet
): { keys: string[]; absence: ShadowNoveltyAbsence[] } {
  const keys: string[] = [];
  const absence: ShadowNoveltyAbsence[] = [];
  for (const pair of composedPairs(candidate)) {
    if (selected.value_pairs.has(pair.id)) continue;
    if (!admitsWitness(
      "available_positive",
      core.map((member) => valuesStanding(member, pair.id))
    )) continue;
    keys.push(pair.label);
    pushAbsence(absence, core, "values", `composed without ${pair.label}`);
  }
  return { keys, absence };
}

function admitEvidence(
  candidate: ShadowSetUtilityInput,
  core: readonly ShadowSetUtilityInput[],
  selected: ShadowSelectedSet
): { keys: string[]; absence: ShadowNoveltyAbsence[] } {
  if (evidenceStanding(candidate, selected) !== "available_positive") {
    return { keys: [], absence: [] };
  }
  if (!admitsWitness(
    "available_positive",
    core.map((member) => evidenceStanding(member, selected))
  )) {
    return { keys: [], absence: [] };
  }
  const cid = candidate.cid.status === "available" ? candidate.cid.cid : "";
  const absence: ShadowNoveltyAbsence[] = [];
  pushAbsence(absence, core, "evidence_identity", "available cid already in S");
  return { keys: [cid], absence };
}

function admitsWitness(
  candidateStanding: ShadowWitnessStanding,
  coreStandings: readonly ShadowWitnessStanding[]
): boolean {
  return lowerFrontierNoveltyAdmission({
    candidate_standing: candidateStanding,
    core_standings: coreStandings
  }) === "admitted";
}

function pushAbsence(
  absence: ShadowNoveltyAbsence[],
  core: readonly ShadowSetUtilityInput[],
  witness: ShadowNoveltyAbsence["witness"],
  basis: string
): void {
  for (const member of core) {
    absence.push({
      witness,
      core_candidate_key: member.candidate_key,
      basis
    });
  }
}

function facilityStanding(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet,
  atom: ShadowObligationKey
): ShadowWitnessStanding {
  const read = readObligationCover(candidate, atom);
  if (read.availability === "unavailable") return "unavailable";
  if (read.availability === "not_observed" || read.availability === "not_applicable") {
    return "not_observed";
  }
  if (!read.evaluated) return "not_observed";
  return remainderOn(candidate, selected, atom) > 0
    ? "available_positive"
    : "available_known_absent";
}

function valuesStanding(
  candidate: ShadowSetUtilityInput,
  pairId: string
): ShadowWitnessStanding {
  if (candidate.values.status !== "composed") return "unavailable";
  return composedPairs(candidate).some((pair) => pair.id === pairId)
    ? "available_positive"
    : "available_known_absent";
}

function evidenceStanding(
  candidate: ShadowSetUtilityInput,
  selected: ShadowSelectedSet
): ShadowWitnessStanding {
  if (candidate.cid.status !== "available") return "unavailable";
  return selected.content_ids.has(candidate.cid.cid)
    ? "available_known_absent"
    : "available_positive";
}

function sortedFreeze(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(compareText));
}

function compareAbsence(
  left: ShadowNoveltyAbsence,
  right: ShadowNoveltyAbsence
): number {
  return compareText(
    `${left.witness}\0${left.core_candidate_key}\0${left.basis}`,
    `${right.witness}\0${right.core_candidate_key}\0${right.basis}`
  );
}
