import { type MemoryEntry, type RecallPolicy } from "@do-soul/alaya-protocol";
import { clamp01, errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import { recordRecallDegradation } from "./diagnostics.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import {
  intentSplitsByAnchor,
  type RecallQueryAnchors,
  type RecallQueryIntent
} from "./recall-query-plan.js";
import {
  EXPANDED_QUERY_RANK_DISCOUNT,
  buildEvidenceSearchQueries,
  buildExpandedKeywordQuery
} from "./coarse-candidates.js";
import type { RunCoarseFilterContext } from "./coarse-filter.js";
import type { AddCoarseCandidate } from "./coarse-filter-admission.js";

export interface SemanticSupplementParams {
  readonly context: RunCoarseFilterContext;
  readonly workspaceId: string;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly anchors: RecallQueryAnchors;
  readonly intent: RecallQueryIntent;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly addCandidate: AddCoarseCandidate;
  readonly ftsRanks: Map<string, number>;
  readonly trigramFtsRanks: Map<string, number>;
  readonly evidenceFtsRanks: Map<string, number>;
  readonly evidenceFtsRanksPerRef: Map<string, number>;
}

export async function addSemanticSupplementCandidates(params: SemanticSupplementParams): Promise<void> {
  if (
    !params.config.semantic_supplement.enabled ||
    params.config.semantic_supplement.max_supplement <= 0 ||
    params.queryText === null ||
    (params.context.dependencies.memoryRepo.searchByKeywordWithinObjectIds === undefined &&
      params.context.dependencies.memoryRepo.searchByKeyword === undefined)
  ) {
    return;
  }

  const memoryRepo = params.context.dependencies.memoryRepo;
  const searchWithinObjectIds = memoryRepo.searchByKeywordWithinObjectIds?.bind(memoryRepo);
  const searchByKeywordFn = memoryRepo.searchByKeyword?.bind(memoryRepo);
  const objectIds = [...params.byId.keys()];
  const supplement =
    searchWithinObjectIds !== undefined
      ? await searchWithinObjectIds(
          params.workspaceId,
          params.queryText,
          params.config.semantic_supplement.max_supplement,
          objectIds
        )
      : searchByKeywordFn !== undefined
        ? await searchByKeywordFn(
            params.workspaceId,
            params.queryText,
            params.config.semantic_supplement.max_supplement
          )
        : [];
  for (const match of supplement) {
    params.ftsRanks.set(match.object_id, clamp01(match.normalized_rank));
    if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
      params.trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank));
    }
    const entry = params.byId.get(match.object_id);
    if (entry !== undefined) {
      params.addCandidate(entry, "lexical", clamp01(match.normalized_rank), "lexical");
    }
  }

  await addAnchorLaneCandidates(params, objectIds);
  await addExpandedKeywordCandidates(params, searchWithinObjectIds, searchByKeywordFn, objectIds);
  await addEvidenceFtsCandidates(params);
}

const MAX_SUBQUERY_ANCHORS = 4;
const MIN_SUBQUERY_ANCHOR_QUOTA = 8;

// Opt-in flags, default OFF: the anchor lane is recall-neutral and slower.
function envOptIn(name: string): boolean {
  const raw = process.env[name];
  return raw === "on" || raw === "1" || raw === "true";
}

type AnchorSearchFn = (
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[],
  limit: number,
  objectIds: readonly string[]
) => Promise<readonly { readonly object_id: string; readonly normalized_rank: number; readonly trigram_rank?: number }[]>;

// Additive; no-op (relaxed lane stands) when there is no anchor or no repo support.
async function addAnchorLaneCandidates(
  params: SemanticSupplementParams,
  objectIds: readonly string[]
): Promise<void> {
  if (params.anchors.required.length === 0 || !envOptIn("ALAYA_RECALL_ANCHOR_LANE")) {
    return;
  }
  const memoryRepo = params.context.dependencies.memoryRepo;
  const searchByAnchor = memoryRepo.searchByAnchorWithinObjectIds?.bind(memoryRepo);
  if (searchByAnchor === undefined) {
    return;
  }
  const quota = params.config.semantic_supplement.max_supplement;
  if (shouldSplitAnchors(params)) {
    const perAnchorQuota = Math.max(
      MIN_SUBQUERY_ANCHOR_QUOTA,
      Math.ceil(quota / params.anchors.required.length)
    );
    for (const anchor of params.anchors.required.slice(0, MAX_SUBQUERY_ANCHORS)) {
      await admitAnchorMatches(params, searchByAnchor, [anchor], perAnchorQuota, objectIds);
    }
    return;
  }
  await admitAnchorMatches(params, searchByAnchor, params.anchors.required, quota, objectIds);
}

// Split a multi-fact query into one anchor lane per anchor so the first cannot crowd the others out. Reserved-quota recall, not delivery.
function shouldSplitAnchors(params: SemanticSupplementParams): boolean {
  return (
    params.anchors.required.length >= 2 &&
    intentSplitsByAnchor(params.intent) &&
    envOptIn("ALAYA_RECALL_SUBQUERY")
  );
}

async function admitAnchorMatches(
  params: SemanticSupplementParams,
  searchByAnchor: AnchorSearchFn,
  requiredAnchors: readonly string[],
  limit: number,
  objectIds: readonly string[]
): Promise<void> {
  const matches = await searchByAnchor(
    params.workspaceId,
    requiredAnchors,
    params.anchors.optional,
    limit,
    objectIds
  );
  for (const match of matches) {
    const ranked = clamp01(match.normalized_rank);
    params.ftsRanks.set(match.object_id, Math.max(params.ftsRanks.get(match.object_id) ?? 0, ranked));
    if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
      params.trigramFtsRanks.set(
        match.object_id,
        Math.max(params.trigramFtsRanks.get(match.object_id) ?? 0, clamp01(match.trigram_rank))
      );
    }
    const entry = params.byId.get(match.object_id);
    if (entry !== undefined) {
      params.addCandidate(entry, "lexical_anchor", ranked, "lexical_anchor");
    }
  }
}

async function addExpandedKeywordCandidates(
  params: SemanticSupplementParams,
  searchWithinObjectIds: ((workspaceId: string, query: string, limit: number, objectIds: readonly string[]) => Promise<readonly { readonly object_id: string; readonly normalized_rank: number; readonly trigram_rank?: number }[]>) | undefined,
  searchByKeywordFn: ((workspaceId: string, query: string, limit: number) => Promise<readonly { readonly object_id: string; readonly normalized_rank: number; readonly trigram_rank?: number }[]>) | undefined,
  objectIds: readonly string[]
): Promise<void> {
  const expandedQuery = buildExpandedKeywordQuery(params.queryProbes);
  if (expandedQuery === null) {
    return;
  }
  const expandedSupplement =
    searchWithinObjectIds !== undefined
      ? await searchWithinObjectIds(
          params.workspaceId,
          expandedQuery,
          params.config.semantic_supplement.max_supplement,
          objectIds
        )
      : searchByKeywordFn !== undefined
        ? await searchByKeywordFn(
            params.workspaceId,
            expandedQuery,
            params.config.semantic_supplement.max_supplement
          )
        : [];
  for (const match of expandedSupplement) {
    const discounted = clamp01(match.normalized_rank) * EXPANDED_QUERY_RANK_DISCOUNT;
    if (discounted <= 0) {
      continue;
    }
    if (!params.ftsRanks.has(match.object_id)) {
      params.ftsRanks.set(match.object_id, discounted);
    }
    if (match.trigram_rank !== undefined && match.trigram_rank > 0 && !params.trigramFtsRanks.has(match.object_id)) {
      params.trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank) * EXPANDED_QUERY_RANK_DISCOUNT);
    }
    const entry = params.byId.get(match.object_id);
    if (entry !== undefined) {
      params.addCandidate(entry, "lexical", discounted, "lexical_expanded");
    }
  }
}

async function addEvidenceFtsCandidates(params: SemanticSupplementParams): Promise<void> {
  if (
    params.context.dependencies.evidenceSearchPort === undefined ||
    params.context.dependencies.memoryRepo.findByEvidenceRefs === undefined ||
    params.queryText === null
  ) {
    return;
  }
  try {
    const evidenceMatchById = new Map<string, number>();
    for (const evidenceQuery of buildEvidenceSearchQueries(params.queryText, params.queryProbes)) {
      const evidenceMatches = await params.context.dependencies.evidenceSearchPort.searchByKeyword(
        params.workspaceId,
        evidenceQuery,
        params.config.semantic_supplement.max_supplement
      );
      for (const match of evidenceMatches) {
        evidenceMatchById.set(
          match.object_id,
          Math.max(evidenceMatchById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
        );
      }
    }
    await admitEvidenceMatches(params, evidenceMatchById);
  } catch (error) {
    recordRecallDegradation(params.context, "evidence_fts_failed");
    params.context.warn("evidence FTS lookup failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_fts_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
  }
}

async function admitEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceMatchById: ReadonlyMap<string, number>
): Promise<void> {
  const evidenceRankById = new Map<string, number>();
  for (const [objectId, normalizedRank] of evidenceMatchById.entries()) {
    const ranked = clamp01(normalizedRank);
    evidenceRankById.set(objectId, ranked);
    params.evidenceFtsRanksPerRef.set(
      objectId,
      Math.max(params.evidenceFtsRanksPerRef.get(objectId) ?? 0, ranked)
    );
  }
  if (evidenceRankById.size === 0 || params.context.dependencies.memoryRepo.findByEvidenceRefs === undefined) {
    return;
  }
  const memoriesByEvidence = await params.context.dependencies.memoryRepo.findByEvidenceRefs(
    params.workspaceId,
    [...evidenceRankById.keys()]
  );
  for (const memory of memoriesByEvidence) {
    if (!params.byId.has(memory.object_id)) {
      continue;
    }
    let bestRank = 0;
    for (const ref of memory.evidence_refs) {
      const evidenceRank = evidenceRankById.get(ref);
      if (evidenceRank !== undefined && evidenceRank > bestRank) {
        bestRank = evidenceRank;
      }
    }
    if (bestRank <= 0) {
      continue;
    }
    params.evidenceFtsRanks.set(
      memory.object_id,
      Math.max(params.evidenceFtsRanks.get(memory.object_id) ?? 0, bestRank)
    );
    params.addCandidate(memory, "lexical", bestRank, "evidence_fts");
  }
}
