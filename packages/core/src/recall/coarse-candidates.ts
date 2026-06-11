import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { EmbeddingRecallSupplementResult } from "../embedding-recall-service.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { clamp01, compareMemoryEntries } from "./recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallPathExpansionSourceDiagnostic,
  RecallSupplementaryData
} from "./recall-service-types.js";
import { uniqueStrings } from "./path-relations.js";

export const DYNAMIC_RECALL_SEED_CAP = 50;
// anchor: entity-derived graph_expansion seeding floor. Only entities whose
// extractor confidence meets this threshold are allowed to fan their FTS
// hits into graph_expansion seeds. The 0.85 cut admits quoted / code_ref /
// path / package / task_ref signals (1.0 / 0.95 / 0.9 / 0.9 / 0.85) and
// excludes proper_noun (0.7), cjk_phrase (0.6), and unknown_long (0.35).
// see also: packages/core/src/entity-extraction-rules.ts:CONFIDENCE_TASK_REF.
export const ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR = 0.85;
export const DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS = 6;
export const DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP = 12;
export const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP = 120;
export const DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_BUDGET_MULTIPLIER = 4;
export const DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED = 8;
export const SOURCE_PROXIMITY_STRUCTURAL_CARRY_MAX = 0.25;
// Expanded-query lexical hits (morphology / synonym variants) are admitted at
// this fraction of their raw fts rank so an inflected-only match cannot
// out-RRF a memory that matched the original query surface terms.
export const EXPANDED_QUERY_RANK_DISCOUNT = 0.6;

export interface CoarseCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly admissionPlanes: readonly RecallAdmissionPlane[];
  readonly firstAdmissionPlane: RecallAdmissionPlane;
  readonly sourceChannels: readonly string[];
  readonly structuralScore: number;
  readonly pathExpansionSources: readonly RecallPathExpansionSourceDiagnostic[];
  // invariant: the strongest entity-extractor confidence (0..1) observed when
  // this draft was admitted via the entity_seed plane; undefined when no
  // entity_seed admission has occurred. selectExpansionSeedDrafts uses this
  // to gate entity-only drafts out of graph_expansion fan-in when the entity
  // confidence falls below ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR.
  // see also: packages/core/src/recall/recall-service.ts:RecallService.collectEntityDerivedSeeds.
  readonly entityConfidence?: number;
  // invariant: sticky-true once this draft is admitted on the path_expansion
  // plane via an EARNED `co_recalled` PathRelation (relation_kind === COG). This
  // is the R1 sparse durable fan-in carrier; the structural delivery reserve
  // reads it as the bounded exemption that admits a zero-relevance earned fan-in
  // sibling without re-opening displacement to generic structural distractors.
  // Gold-blind. see also: packages/core/src/recall/fusion-delivery.ts:isStructuralRescueCandidate.
  readonly reachedViaEarnedCoRecalledFanin?: boolean;
}

export interface SourceProximitySeedDraft {
  readonly draft: Readonly<CoarseCandidateDraft>;
  readonly strength: number;
}

export function withEmbeddingSimilarityScores(
  supplementaryData: RecallSupplementaryData,
  hintsByObjectId: EmbeddingRecallSupplementResult["similarityHintsByObjectId"],
  injectedSimilarityScores: Readonly<Record<string, number>>
): RecallSupplementaryData {
  const merged = new Map<string, number>();
  for (const [objectId, hint] of Object.entries(hintsByObjectId)) {
    const score = clamp01(hint.normalized_similarity);
    if (score > 0) {
      merged.set(objectId, Math.max(merged.get(objectId) ?? 0, score));
    }
  }
  for (const [objectId, rawScore] of Object.entries(injectedSimilarityScores)) {
    const score = clamp01(rawScore);
    if (score > 0) {
      merged.set(objectId, Math.max(merged.get(objectId) ?? 0, score));
    }
  }
  if (merged.size === 0) {
    return supplementaryData;
  }

  return Object.freeze({
    ...supplementaryData,
    embeddingSimilarityScores: Object.freeze(Object.fromEntries(merged))
  });
}

export function buildEvidenceSearchQueries(
  queryText: string,
  queryProbes: Readonly<RecallQueryProbes>
): readonly string[] {
  const phraseQueries = queryProbes.phrases
    .filter((phrase) => phrase.length >= 3)
    .slice(0, 8);
  const multiKeyQuery = queryProbes.lexical_terms.slice(0, 8).join(" ");
  const expandedKeyQuery = queryProbes.expanded_terms.slice(0, 8).join(" ");
  const dateQueries = queryProbes.date_terms.slice(0, 6);
  return uniqueStrings([
    queryText,
    ...phraseQueries,
    ...(multiKeyQuery.length === 0 ? [] : [multiKeyQuery]),
    ...(expandedKeyQuery.length === 0 ? [] : [expandedKeyQuery]),
    ...dateQueries
  ].map((value) => value.trim()).filter((value) => value.length > 0));
}

// Deterministic OR-query of expanded lexical terms (morphology + synonym
// variants). Returns null when there is nothing to expand so callers can skip
// the extra FTS pass. see also: packages/core/src/recall/recall-query-probes.ts:expandLexicalTerms.
export function buildExpandedKeywordQuery(queryProbes: Readonly<RecallQueryProbes>): string | null {
  const expanded = uniqueStrings(
    queryProbes.expanded_terms.slice(0, 16).map((term) => term.trim()).filter((term) => term.length > 0)
  );
  return expanded.length === 0 ? null : expanded.join(" ");
}

export function scoreObjectProbeMatch(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  let score = 0;
  if (queryProbes.object_ids.includes(entry.object_id)) {
    score += 1;
  }
  if (entry.evidence_refs.some((ref) => queryProbes.evidence_refs.includes(ref))) {
    score += 0.9;
  }
  if (entry.run_id !== null && queryProbes.run_ids.includes(entry.run_id)) {
    score += 0.8;
  }
  if (entry.surface_id !== null && queryProbes.surface_ids.includes(entry.surface_id)) {
    score += 0.8;
  }
  if (queryProbes.dimensions.includes(entry.dimension)) {
    score += 0.55;
  }
  if (queryProbes.scope_classes.includes(entry.scope_class)) {
    score += 0.45;
  }
  if (entry.domain_tags.some((tag) => queryProbes.domain_tags.includes(tag))) {
    score += 0.45;
  }
  const structuralNeedles = [
    ...queryProbes.file_paths,
    ...queryProbes.package_names,
    ...queryProbes.command_names,
    ...queryProbes.task_refs
  ].map((value) => value.toLocaleLowerCase());
  if (structuralNeedles.length > 0) {
    const haystack = [
      entry.content,
      ...entry.domain_tags,
      ...entry.evidence_refs
    ].join("\n").toLocaleLowerCase();
    if (structuralNeedles.some((needle) => haystack.includes(needle))) {
      score += 0.5;
    }
  }
  return clamp01(score);
}

export function scoreDomainTagCluster(
  entry: Readonly<MemoryEntry>,
  domainTags: ReadonlySet<string>,
  queryTags: ReadonlySet<string>,
  tagFrequency: ReadonlyMap<string, number>,
  commonTagLimit: number
): number {
  const matchingTags = entry.domain_tags.filter((tag) => domainTags.has(tag));
  if (matchingTags.length === 0) {
    return 0;
  }
  const usableTags = matchingTags.filter((tag) => queryTags.has(tag) || (tagFrequency.get(tag) ?? 0) <= commonTagLimit);
  if (usableTags.length === 0) {
    return 0;
  }
  const queryOverlap = usableTags.some((tag) => queryTags.has(tag)) ? 0.2 : 0;
  return clamp01(0.35 + usableTags.length * 0.12 + queryOverlap);
}

export function countDomainTags(entries: readonly Readonly<MemoryEntry>[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.domain_tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

export function selectExpansionSeedEntries(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>,
  fallbackEntries: readonly Readonly<MemoryEntry>[]
): readonly Readonly<MemoryEntry>[] {
  const draftSeeds = selectExpansionSeedDrafts(drafts).map((draft) => draft.entry);
  if (draftSeeds.length > 0) {
    return draftSeeds;
  }
  return [...fallbackEntries].sort(compareMemoryEntries).slice(0, DYNAMIC_RECALL_SEED_CAP);
}

export interface EvidenceSourceChunkRef {
  readonly sourceKey: string;
  readonly chunkIndex: number;
}

export interface EvidenceSourceChunkEntry {
  readonly entry: Readonly<MemoryEntry>;
  readonly chunkIndex: number;
}

export function buildEvidenceSourceChunkIndex(
  entries: readonly Readonly<MemoryEntry>[],
  sourceRefsByMemoryId?: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, readonly EvidenceSourceChunkEntry[]> {
  const bySource = new Map<string, EvidenceSourceChunkEntry[]>();
  for (const entry of entries) {
    for (const ref of sourceRefsByMemoryId?.get(entry.object_id) ?? entry.evidence_refs) {
      const parsed = parseEvidenceSourceChunkRef(ref);
      if (parsed === null) {
        continue;
      }
      const current = bySource.get(parsed.sourceKey) ?? [];
      current.push({ entry, chunkIndex: parsed.chunkIndex });
      bySource.set(parsed.sourceKey, current);
    }
  }
  return new Map(
    [...bySource.entries()].map(([sourceKey, values]) => [
      sourceKey,
      Object.freeze(
        values.sort((left, right) => {
          const chunkDelta = left.chunkIndex - right.chunkIndex;
          return chunkDelta === 0 ? compareMemoryEntries(left.entry, right.entry) : chunkDelta;
        })
      )
    ] as const)
  );
}

export function buildEvidenceSourceCohortKeys(
  entries: readonly Readonly<MemoryEntry>[],
  sourceRefsByMemoryId: ReadonlyMap<string, readonly string[]>
): Readonly<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const entry of entries) {
    const cohortKey = selectEvidenceSourceCohortKey(sourceRefsByMemoryId.get(entry.object_id) ?? entry.evidence_refs);
    if (cohortKey !== null) {
      keys[entry.object_id] = cohortKey;
    }
  }
  return Object.freeze(keys);
}

export function selectEvidenceSourceCohortKey(refs: readonly string[]): string | null {
  for (const ref of refs) {
    const parsed = parseEvidenceSourceChunkRef(ref);
    if (parsed !== null && parsed.sourceKey.length > 0) {
      return parsed.sourceKey;
    }
  }
  return null;
}

export function parseEvidenceSourceChunkRef(ref: string): EvidenceSourceChunkRef | null {
  const normalized = ref.trim().toLowerCase();
  const sessionTurn = /^(.*?)(?:[-_./#:])s(?:ession)?[-_]?(\d+)(?:[-_./#:])t(?:urn)?[-_]?(\d+)$/.exec(normalized);
  if (sessionTurn !== null) {
    const [, prefix, session, turn] = sessionTurn;
    return {
      sourceKey: `${prefix ?? ""}|session:${session ?? ""}`,
      chunkIndex: Number.parseInt(turn ?? "", 10)
    };
  }

  const chunk = /^(.*?)(?:[-_./#:])(?:chunk|turn|t)[-_]?(\d+)$/.exec(normalized);
  if (chunk !== null) {
    const [, prefix, index] = chunk;
    return {
      sourceKey: prefix ?? "",
      chunkIndex: Number.parseInt(index ?? "", 10)
    };
  }

  return null;
}

export function selectPreferredExpansionSeedEntries(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly Readonly<MemoryEntry>[] {
  // invariant: mirrors the weak-entity-only filter that
  // seed selection mirrors selectExpansionSeedDrafts on the graph_expansion path. The
  // seeds returned here drive the evidence_anchor / domain_tag_cluster
  // planes in packages/core/src/recall/recall-service.ts:RecallService.addContentDerivedExpansionCandidates (evidence_refs and
  // domain_tags of these seeds widen the per-plane match set). A weak
  // cjk_phrase / proper_noun / unknown surface (confidence below
  // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR) admitted ONLY on
  // entity_seed must not be allowed to seed content expansion either —
  // otherwise the same surface manipulation that the graph_expansion
  // floor blocks would leak through evidence/tag fan-out.
  // Defense-in-depth: today addContentDerivedExpansionCandidates is
  // called before packages/core/src/recall/recall-service.ts:RecallService.collectEntityDerivedSeeds, so no entity_seed draft
  // is present at the moment this seed pool is built. The filter is
  // applied anyway so any future reordering, or a follow-up caller
  // that runs after entity_seed admission, cannot silently bypass
  // the graph_expansion floor via the content-expansion lane.
  // see also: packages/core/src/recall/coarse-candidates.ts:isWeakEntityOnlyDraft,
  // packages/core/src/recall/coarse-candidates.ts:selectExpansionSeedDrafts.
  return rankCoarseCandidateDrafts([...drafts.values()])
    .filter((draft) => !isWeakEntityOnlyDraft(draft))
    // semantic_supplement candidates carry no structural anchor and must not
    // seed graph_expansion; they would expand from an unrelated neighbor.
    .filter((draft) =>
      draft.admissionPlanes.some(
        (plane) => plane !== "activation" && plane !== "semantic_supplement"
      ) || draft.structuralScore > 0
    )
    .slice(0, DYNAMIC_RECALL_SEED_CAP)
    .map((draft) => draft.entry);
}

export function selectExpansionSeedDrafts(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly Readonly<CoarseCandidateDraft>[] {
  const ranked = rankCoarseCandidateDrafts([...drafts.values()]);
  // invariant: a draft whose ONLY non-activation admission is entity_seed,
  // and whose strongest observed entity confidence is below the floor, must
  // not seed graph_expansion. Mirrors the confidence gate in
  // packages/core/src/recall/recall-service.ts:RecallService.collectEntityDerivedSeeds on
  // the extraSeedMemoryIds path — without this, a weak cjk_phrase /
  // proper_noun query surface (confidence 0.35-0.7) that hit only the
  // entity-FTS lane would still fan into the graph via path (1) and let
  // an attacker compound surface manipulation across 1-hop neighbors.
  // see also: packages/core/src/recall/coarse-candidates.ts:ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR,
  // packages/core/src/recall/recall-service.ts:RecallService.addGraphExpansionCandidates.
  const survivors = ranked.filter((draft) => !isWeakEntityOnlyDraft(draft));
  const preferred = survivors
    .filter((draft) =>
      draft.admissionPlanes.some(
        (plane) => plane !== "activation" && plane !== "semantic_supplement"
      ) || draft.structuralScore > 0
    )
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const preferredIds = new Set(preferred.map((draft) => draft.entry.object_id));
  return [
    ...preferred,
    ...survivors.filter((draft) => !preferredIds.has(draft.entry.object_id))
  ].slice(0, DYNAMIC_RECALL_SEED_CAP);
}

// anchor: entity-only graph_expansion floor. A draft is "weak entity-only"
// when its admission_planes contain entity_seed and NO other non-activation
// plane co-admitted (no lexical, object_probe, evidence_anchor, etc.) and
// the strongest entity confidence is below the floor. Drafts with a real
// co-admitting plane (lexical hit, structural agreement, etc.) survive,
// even when the entity confidence is weak.
function isWeakEntityOnlyDraft(draft: Readonly<CoarseCandidateDraft>): boolean {
  const planes = draft.admissionPlanes;
  if (!planes.includes("entity_seed")) {
    return false;
  }
  const hasNonEntitySupport = planes.some(
    (plane) => plane !== "entity_seed" && plane !== "activation"
  );
  if (hasNonEntitySupport) {
    return false;
  }
  const confidence = draft.entityConfidence ?? 0;
  return confidence < ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR;
}

export function selectSourceProximitySeedDrafts(
  drafts: ReadonlyMap<string, CoarseCandidateDraft>
): readonly SourceProximitySeedDraft[] {
  return rankCoarseCandidateDrafts([...drafts.values()])
    .map((draft) => Object.freeze({
      draft,
      strength: scoreSourceProximitySeedDraft(draft)
    }))
    .filter((seed) => seed.strength > 0)
    .sort((left, right) => {
      const strengthDelta = right.strength - left.strength;
      if (strengthDelta !== 0) {
        return strengthDelta;
      }
      return compareMemoryEntries(left.draft.entry, right.draft.entry);
    })
    .slice(0, DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP);
}

function scoreSourceProximitySeedDraft(draft: Readonly<CoarseCandidateDraft>): number {
  let strength = 0;
  if (draft.admissionPlanes.includes("protected_winner")) {
    strength = 1;
  }
  if (draft.admissionPlanes.includes("evidence_anchor")) {
    strength = Math.max(strength, 0.95);
  }
  if (draft.admissionPlanes.includes("object_probe")) {
    strength = Math.max(strength, 0.9);
  }
  if (draft.admissionPlanes.includes("session_surface_cohort")) {
    strength = Math.max(strength, 0.75);
  }
  if (draft.admissionPlanes.includes("lexical")) {
    strength = Math.max(strength, draft.structuralScore);
  }
  return strength >= 0.35 ? clamp01(strength) : 0;
}

export function resolveSourceProximityAdmissionLimit(maxDeliveryEntries: number | undefined): number {
  if (maxDeliveryEntries !== undefined && maxDeliveryEntries <= 0) {
    return 0;
  }
  const budgetBound =
    maxDeliveryEntries === undefined
      ? DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP
      : Math.max(
          DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED,
          maxDeliveryEntries * DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_BUDGET_MULTIPLIER
        );
  return Math.min(DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP, budgetBound);
}

export function rankCoarseCandidateDrafts(
  drafts: readonly Readonly<CoarseCandidateDraft>[]
): readonly Readonly<CoarseCandidateDraft>[] {
  return [...drafts].sort((left, right) => {
    const priorityDelta = draftPriority(right) - draftPriority(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const structuralDelta = right.structuralScore - left.structuralScore;
    if (structuralDelta !== 0) {
      return structuralDelta;
    }
    return compareMemoryEntries(left.entry, right.entry);
  });
}

function draftPriority(draft: Readonly<CoarseCandidateDraft>): number {
  if (draft.admissionPlanes.includes("protected_winner")) {
    return 5;
  }
  if (draft.admissionPlanes.includes("object_probe")) {
    return 4;
  }
  if (draft.admissionPlanes.some((plane) =>
    plane === "evidence_anchor" ||
    plane === "domain_tag_cluster" ||
    plane === "session_surface_cohort" ||
    plane === "source_proximity" ||
    plane === "graph_expansion" ||
    plane === "path_expansion"
  )) {
    return 3;
  }
  if (draft.admissionPlanes.includes("lexical") || draft.admissionPlanes.includes("entity_seed")) {
    return 3;
  }
  // Semantic-supplement injections lack lexical / structural anchors; rank
  // them above raw activation-only candidates but below any plane that
  // carries a real anchor. see also: packages/core/src/recall/supplements.ts:collectEmbeddingCoarseInjection.
  if (draft.admissionPlanes.includes("semantic_supplement")) {
    return 2;
  }
  return 1;
}

export function uniquePlanes(values: readonly RecallAdmissionPlane[]): readonly RecallAdmissionPlane[] {
  return [...new Set(values)];
}
