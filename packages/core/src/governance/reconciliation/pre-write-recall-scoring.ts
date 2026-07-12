import type { MemoryEntry } from "@do-soul/alaya-protocol";

import {
  jaccardIndex,
  normalizeForIdentity,
  tokenize,
  type ReconciliationInput
} from "./reconciliation-service-internal.js";
import type {
  PreWriteCandidateFamily,
  PreWriteCandidateNeighbor,
  PreWriteRelationPosterior
} from "./pre-write-recall-service.js";

export const STRUCTURAL_SCAN_LIMIT = 64;

const STRUCTURAL_FAMILY_ORDER: readonly PreWriteCandidateFamily[] = [
  "typed_slot",
  "canonical_entity",
  "temporal",
  "domain_tag"
];

const FINAL_FAMILY_ORDER: readonly PreWriteCandidateFamily[] = [
  "typed_slot",
  "canonical_entity",
  "temporal",
  "lexical",
  "domain_tag"
];

export interface StructuralCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly score: number;
  readonly families: readonly PreWriteCandidateFamily[];
}

export interface StructuralProbe {
  readonly queryText: string;
  readonly family: PreWriteCandidateFamily;
}

export function scoreCandidate(
  input: ReconciliationInput,
  entry: Readonly<MemoryEntry>,
  retrievedFamilies: ReadonlySet<PreWriteCandidateFamily>
): PreWriteCandidateNeighbor {
  const lexicalScore = jaccardIndex(tokenize(input.incomingContent), tokenize(entry.content));
  const tagScore = jaccardIndex(new Set(input.incomingDomainTags), new Set(entry.domain_tags));
  const entityScore = jaccardIndex(
    new Set(input.incomingProjectionFields?.canonical_entities ?? []),
    new Set(entry.canonical_entities ?? [])
  );
  const slotScore = scoreTypedSlot(input.incomingProjectionFields, entry);
  const temporalScore = scoreTemporalOverlap(input.incomingProjectionFields, entry);
  const structuralScore = Math.max(tagScore * 0.7, entityScore, slotScore, temporalScore * 0.6);
  const families = expandFamilies(retrievedFamilies, {
    tagScore,
    entityScore,
    slotScore,
    temporalScore
  });

  return {
    entry,
    families,
    lexicalScore,
    structuralScore,
    tagScore,
    entityScore,
    slotScore,
    temporalScore,
    relationPosteriors: estimateRelations(input, entry, lexicalScore, structuralScore, slotScore)
  };
}

export function structuralFamiliesFor(
  input: ReconciliationInput,
  entry: Readonly<MemoryEntry>
): readonly PreWriteCandidateFamily[] {
  const families: PreWriteCandidateFamily[] = [];
  if (jaccardIndex(new Set(input.incomingDomainTags), new Set(entry.domain_tags)) > 0) {
    families.push("domain_tag");
  }
  if (
    jaccardIndex(
      new Set(input.incomingProjectionFields?.canonical_entities ?? []),
      new Set(entry.canonical_entities ?? [])
    ) > 0
  ) {
    families.push("canonical_entity");
  }
  if (scoreTypedSlot(input.incomingProjectionFields, entry) > 0) {
    families.push("typed_slot");
  }
  if (scoreTemporalOverlap(input.incomingProjectionFields, entry) > 0) {
    families.push("temporal");
  }
  return families;
}

export function buildStructuralProbes(input: ReconciliationInput): readonly StructuralProbe[] {
  const probes: StructuralProbe[] = [];
  for (const tag of input.incomingDomainTags) {
    pushProbe(probes, tag, "domain_tag");
  }
  for (const entity of input.incomingProjectionFields?.canonical_entities ?? []) {
    pushProbe(probes, entity, "canonical_entity");
  }
  for (const value of typedSlotProbeValues(input.incomingProjectionFields)) {
    pushProbe(probes, value, "typed_slot");
  }
  for (const value of temporalProbeValues(input.incomingProjectionFields)) {
    pushProbe(probes, value, "temporal");
  }
  return dedupeProbes(probes);
}

export function scoreStructuralRecall(input: ReconciliationInput, entry: Readonly<MemoryEntry>): number {
  const families = structuralFamiliesFor(input, entry);
  if (families.length === 0) {
    return 0;
  }
  return Math.max(
    jaccardIndex(new Set(input.incomingDomainTags), new Set(entry.domain_tags)) * 0.7,
    jaccardIndex(new Set(input.incomingProjectionFields?.canonical_entities ?? []), new Set(entry.canonical_entities ?? [])),
    scoreTypedSlot(input.incomingProjectionFields, entry),
    scoreTemporalOverlap(input.incomingProjectionFields, entry) * 0.6
  );
}

export function selectStructuralEntries(
  candidates: readonly StructuralCandidate[],
  limit: number
): readonly Readonly<MemoryEntry>[] {
  const selected = new Map<string, Readonly<MemoryEntry>>();
  for (const family of STRUCTURAL_FAMILY_ORDER) {
    let admitted = 0;
    for (const candidate of candidates) {
      if (admitted >= limit) {
        break;
      }
      if (candidate.families.includes(family)) {
        selected.set(candidate.entry.object_id, candidate.entry);
        admitted += 1;
      }
    }
  }
  return [...selected.values()];
}

export function selectFinalCandidates(
  candidates: readonly PreWriteCandidateNeighbor[],
  limit: number
): readonly PreWriteCandidateNeighbor[] {
  const selected = new Map<string, PreWriteCandidateNeighbor>();
  for (const family of FINAL_FAMILY_ORDER) {
    const match = candidates.find((candidate) => candidate.families.includes(family));
    if (match !== undefined) {
      selected.set(match.entry.object_id, match);
    }
    if (selected.size >= limit) {
      return [...selected.values()].sort(compareCandidateNeighbors);
    }
  }
  for (const candidate of candidates) {
    selected.set(candidate.entry.object_id, candidate);
    if (selected.size >= limit) {
      break;
    }
  }
  return [...selected.values()].sort(compareCandidateNeighbors);
}

export function compareStructuralCandidate(left: StructuralCandidate, right: StructuralCandidate): number {
  return right.score - left.score || left.entry.object_id.localeCompare(right.entry.object_id);
}

export function compareCandidateNeighbors(left: PreWriteCandidateNeighbor, right: PreWriteCandidateNeighbor): number {
  const leftScore = Math.max(left.lexicalScore, left.structuralScore);
  const rightScore = Math.max(right.lexicalScore, right.structuralScore);
  return rightScore - leftScore || right.families.length - left.families.length;
}

export function computeUncertainty(candidates: readonly PreWriteCandidateNeighbor[]): number {
  if (candidates.length === 0) {
    return 1;
  }
  const best = Math.max(...candidates.map((candidate) => Math.max(candidate.lexicalScore, candidate.structuralScore)));
  return clamp01(1 - best);
}

export function countFamilies(
  candidates: readonly PreWriteCandidateNeighbor[]
): Record<PreWriteCandidateFamily, number> {
  const counts: Record<PreWriteCandidateFamily, number> = {
    lexical: 0,
    domain_tag: 0,
    canonical_entity: 0,
    typed_slot: 0,
    temporal: 0
  };
  for (const candidate of candidates) {
    for (const family of candidate.families) {
      counts[family] += 1;
    }
  }
  return counts;
}

function expandFamilies(
  retrievedFamilies: ReadonlySet<PreWriteCandidateFamily>,
  scores: {
    readonly tagScore: number;
    readonly entityScore: number;
    readonly slotScore: number;
    readonly temporalScore: number;
  }
): readonly PreWriteCandidateFamily[] {
  const families = new Set(retrievedFamilies);
  if (scores.tagScore > 0) families.add("domain_tag");
  if (scores.entityScore > 0) families.add("canonical_entity");
  if (scores.slotScore > 0) families.add("typed_slot");
  if (scores.temporalScore > 0) families.add("temporal");
  return [...families].sort();
}

function typedSlotProbeValues(
  incoming: ReconciliationInput["incomingProjectionFields"]
): readonly string[] {
  if (incoming === undefined) {
    return [];
  }
  return [
    incoming.preference_subject,
    incoming.preference_predicate,
    incoming.preference_object,
    incoming.preference_category,
    incoming.preference_polarity
  ].filter(isPresentString);
}

function temporalProbeValues(
  incoming: ReconciliationInput["incomingProjectionFields"]
): readonly string[] {
  if (incoming === undefined) {
    return [];
  }
  return [
    incoming.valid_from,
    incoming.valid_to,
    incoming.event_time_start,
    incoming.event_time_end
  ].filter(isPresentString);
}

function pushProbe(
  probes: StructuralProbe[],
  queryText: string | null | undefined,
  family: PreWriteCandidateFamily
): void {
  if (isPresentString(queryText)) {
    probes.push({ queryText, family });
  }
}

function dedupeProbes(probes: readonly StructuralProbe[]): readonly StructuralProbe[] {
  const seen = new Set<string>();
  return probes.filter((probe) => {
    const key = `${probe.family}:${normalizeForIdentity(probe.queryText)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scoreTypedSlot(
  incoming: ReconciliationInput["incomingProjectionFields"],
  entry: Readonly<MemoryEntry>
): number {
  if (incoming === undefined) {
    return 0;
  }
  const pairs = [
    [incoming.preference_subject, entry.preference_subject],
    [incoming.preference_predicate, entry.preference_predicate],
    [incoming.preference_object, entry.preference_object],
    [incoming.preference_category, entry.preference_category],
    [incoming.preference_polarity, entry.preference_polarity]
  ] as const;
  let present = 0;
  let matched = 0;
  for (const [left, right] of pairs) {
    if (!isPresentString(left)) {
      continue;
    }
    present += 1;
    if (right === left) {
      matched += 1;
    }
  }
  return present === 0 ? 0 : matched / present;
}

function scoreTemporalOverlap(
  incoming: ReconciliationInput["incomingProjectionFields"],
  entry: Readonly<MemoryEntry>
): number {
  if (incoming === undefined) {
    return 0;
  }
  const incomingRange = normalizeRange(incoming.valid_from ?? incoming.event_time_start, incoming.valid_to ?? incoming.event_time_end);
  const entryRange = normalizeRange(entry.valid_from ?? entry.event_time_start, entry.valid_to ?? entry.event_time_end);
  if (incomingRange === null || entryRange === null) {
    return 0;
  }
  if (incomingRange.start <= entryRange.end && entryRange.start <= incomingRange.end) {
    return 1;
  }
  return 0;
}

function normalizeRange(
  startValue: string | null | undefined,
  endValue: string | null | undefined
): { readonly start: number; readonly end: number } | null {
  const start = Date.parse(startValue ?? endValue ?? "");
  const end = Date.parse(endValue ?? startValue ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return start <= end ? { start, end } : { start: end, end: start };
}

function estimateRelations(
  input: ReconciliationInput,
  entry: Readonly<MemoryEntry>,
  lexicalScore: number,
  structuralScore: number,
  slotScore: number
): readonly PreWriteRelationPosterior[] {
  if (normalizeForIdentity(input.incomingContent) === normalizeForIdentity(entry.content)) {
    return [{ relation: "same_as", probability: 0.99 }];
  }
  const sameSlotDivergent = slotScore >= 0.6 && lexicalScore < 0.25;
  const refines = Math.max(lexicalScore, structuralScore) >= 0.35 ? 0.55 : 0.15;
  return [
    { relation: sameSlotDivergent ? "contradicts" : "refines", probability: sameSlotDivergent ? 0.45 : refines },
    { relation: "distinct", probability: 1 - (sameSlotDivergent ? 0.45 : refines) }
  ];
}

function isPresentString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
