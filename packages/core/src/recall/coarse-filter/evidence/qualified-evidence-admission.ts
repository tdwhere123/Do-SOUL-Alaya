import {
  mergeFtsLaneIds,
  readVerifiedUserAssertionSourceHashDigest,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import type {
  RecallVerifiedUserSupportSource
} from "../../query/recall-answer-support-observation.js";
import type {
  KeywordSearchResult,
  RecallEvidenceSearchMatch,
  RecallEvidenceSearchProjectionIdentity,
  RecallQualifiedEvidence
} from "../../runtime/recall-service-types.js";
import type { RecallEvidenceProjectionMatchReceipt } from
  "../../runtime/recall-service-results.js";
import type {
  SemanticSupplementParams
} from "../coarse-filter-semantic.js";
import {
  buildDirectEvidencePseudoMemoryEntry,
  isDirectRecallEvidence
} from "./direct-evidence-candidate.js";

interface QualifiedEvidenceCandidate {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly rank: number;
  readonly documentIdentity: string;
  readonly recallText?: string;
  readonly sourceRole?: "user" | "assistant";
  readonly verifiedUserSupportSource?: Readonly<RecallVerifiedUserSupportSource>;
}

interface QualifiedEvidenceLoad {
  readonly candidates: readonly QualifiedEvidenceCandidate[];
  readonly evidenceRankById: ReadonlyMap<string, number>;
}

export async function admitQualifiedEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceMatches: readonly Readonly<KeywordSearchResult>[]
): Promise<void> {
  const evidenceRankById = buildEvidenceRankById(evidenceMatches);
  const loaded = await loadQualifiedEvidenceOrFallback(
    params,
    evidenceMatches,
    evidenceRankById
  );
  if (loaded === null) return;
  const direct = loaded.candidates.filter(({ capsule }) =>
    isDirectRecallEvidence(capsule, params.workspaceId)
  );
  const boundRefs = await loadBoundEvidenceRefsOrFallback(
    params, loaded.evidenceRankById, direct
  );
  if (boundRefs === null) return;
  const unbound = direct.filter(({ capsule }) => !boundRefs.has(capsule.object_id));
  const unboundIds = new Set(unbound.map(({ capsule }) => capsule.object_id));
  const ordinaryRanks = new Map(
    [...loaded.evidenceRankById].filter(([objectId]) => !unboundIds.has(objectId))
  );
  await admitMemoryEvidenceMatches(params, ordinaryRanks);
  await admitDirectEvidenceMatches(params, unbound);
}

async function loadQualifiedEvidenceOrFallback(
  params: SemanticSupplementParams,
  evidenceMatches: readonly Readonly<KeywordSearchResult>[],
  evidenceRankById: ReadonlyMap<string, number>
): Promise<Readonly<QualifiedEvidenceLoad> | null> {
  const findQualified =
    params.context.dependencies.evidenceSearchPort?.findRecallQualifiedByIds;
  if (findQualified === undefined) {
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    return null;
  }
  try {
    const matches = evidenceMatches.map(toEvidenceSearchMatch);
    const qualified = await findQualified.call(
      params.context.dependencies.evidenceSearchPort,
      params.workspaceId,
      matches
    );
    return buildQualifiedEvidenceLoad(params, evidenceMatches, qualified);
  } catch (error) {
    if (isEvidenceProjectionIntegrityError(error)) throw error;
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    throw error;
  }
}

function buildQualifiedEvidenceLoad(
  params: SemanticSupplementParams,
  evidenceMatches: readonly Readonly<KeywordSearchResult>[],
  qualified: readonly Readonly<RecallQualifiedEvidence>[]
): Readonly<QualifiedEvidenceLoad> {
  const ownerRankById = buildOwnerRankById(evidenceMatches);
  const matchByProjection = buildProjectionMatchByKey(evidenceMatches);
  const acceptedRanks = new Map<string, number>();
  const resolvedIds = new Set(qualified.map(({ capsule }) => capsule.object_id));
  const candidates = qualified.flatMap((result) => {
    if (isVerifiedAssertionOwnerMatch(result)) return [];
    const matchedSearch = result.matched_projection === undefined
      ? undefined
      : matchByProjection.get(projectionMatchKey(
        result.capsule.object_id,
        result.matched_projection
      ));
    const rank = result.matched_projection === undefined
      ? ownerRankById.get(result.capsule.object_id)
      : matchedSearch?.normalized_rank;
    if (rank === undefined) return [];
    acceptedRanks.set(
      result.capsule.object_id,
      Math.max(acceptedRanks.get(result.capsule.object_id) ?? 0, rank)
    );
    recordQualifiedProjectionMatch(
      params, result, rank, matchedSearch?.matched_fts_lanes ?? []
    );
    const candidate = projectQualifiedEvidenceCandidate(result, rank);
    return candidate === null ? [] : [candidate];
  });
  for (const [objectId, rank] of buildEvidenceRankById(evidenceMatches)) {
    if (!resolvedIds.has(objectId)) acceptedRanks.set(objectId, rank);
  }
  return Object.freeze({
    candidates: selectQualifiedEvidenceCandidates(candidates),
    evidenceRankById: acceptedRanks
  });
}

function isVerifiedAssertionOwnerMatch(
  qualified: Readonly<RecallQualifiedEvidence>
): boolean {
  return qualified.matched_projection === undefined &&
    readVerifiedUserAssertionSourceHashDigest(
      qualified.capsule.source_hash
    ) !== null;
}

function recordQualifiedProjectionMatch(
  params: SemanticSupplementParams,
  qualified: Readonly<RecallQualifiedEvidence>,
  rank: number,
  matchedFtsLanes: NonNullable<KeywordSearchResult["matched_fts_lanes"]>
): void {
  const evidenceRef = qualified.capsule.object_id;
  const projection = qualified.matched_projection;
  const projectionKind = projection?.projection_kind === "assistant_observation" ||
    projection?.projection_kind === "fact_key"
    ? projection.projection_kind
    : "owner";
  const receipt: RecallEvidenceProjectionMatchReceipt = Object.freeze({
    evidence_ref: evidenceRef,
    projection_kind: projectionKind,
    projection_id: projectionKind === "owner" ? null : projection?.projection_id ?? null,
    normalized_rank: rank,
    ...(matchedFtsLanes.length === 0 ? {} : {
      matched_fts_lanes: mergeFtsLaneIds(matchedFtsLanes)
    }),
    fact_key_forms: Object.freeze([...(qualified.matched_fact_key_forms ?? [])]),
    ...(qualified.matched_fact_frame === undefined ? {} : {
      fact_slots: Object.freeze(qualified.matched_fact_frame.slots.map((slot) =>
        Object.freeze({ ...slot })
      ))
    })
  });
  const current = params.evidenceProjectionMatchesByRef.get(evidenceRef) ?? [];
  const identity = projectionMatchReceiptIdentity(receipt);
  const retained = current.filter((candidate) =>
    projectionMatchReceiptIdentity(candidate) !== identity
  );
  const existing = current.find((candidate) =>
    projectionMatchReceiptIdentity(candidate) === identity
  );
  const preferred = existing !== undefined && existing.normalized_rank > rank
    ? existing
    : receipt;
  const mergedLanes = mergeFtsLaneIds(
    existing?.matched_fts_lanes ?? [],
    receipt.matched_fts_lanes ?? []
  );
  params.evidenceProjectionMatchesByRef.set(evidenceRef, [
    ...retained,
    Object.freeze({
      ...preferred,
      ...(mergedLanes.length === 0 ? {} : { matched_fts_lanes: mergedLanes })
    })
  ]);
}

function projectionMatchReceiptIdentity(
  receipt: Readonly<RecallEvidenceProjectionMatchReceipt>
): string {
  return `${receipt.projection_kind}:${receipt.projection_id ?? "owner"}`;
}

export function isEvidenceProjectionIntegrityError(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "EvidenceProjectionIntegrityError";
}

function toEvidenceSearchMatch(
  result: Readonly<KeywordSearchResult>
): Readonly<RecallEvidenceSearchMatch> {
  return Object.freeze({
    object_id: result.object_id,
    ...(result.matched_projection === undefined
      ? {}
      : {
        matched_projection: Object.freeze({
          projection_id: result.matched_projection.projection_id,
          projection_kind: result.matched_projection.projection_kind
        })
      })
  });
}

function projectQualifiedEvidenceCandidate(
  qualified: Readonly<RecallQualifiedEvidence>,
  rank: number
): Readonly<QualifiedEvidenceCandidate> | null {
  if (qualified.matched_projection?.projection_kind === "assistant_observation") {
    return Object.freeze({
      capsule: qualified.capsule,
      rank,
      documentIdentity:
        `assistant_observation:${qualified.matched_projection.projection_id}`,
      recallText: qualified.matched_projection.content,
      sourceRole: "assistant"
    });
  }
  if (qualified.matched_projection?.projection_kind === "fact_key") {
    const verifiedUserSupportSource = buildVerifiedUserSupportSource(qualified);
    return Object.freeze({
      capsule: qualified.capsule,
      rank,
      documentIdentity:
        `fact_key:${qualified.matched_projection.projection_id}`,
      recallText: qualified.matched_projection.content,
      ...(verifiedUserSupportSource === undefined ? {} : {
        sourceRole: "user" as const,
        verifiedUserSupportSource
      })
    });
  }
  if (qualified.matched_projection !== undefined) return null;
  const verifiedUserSupportSource = buildVerifiedUserSupportSource(qualified);
  return Object.freeze({
    capsule: qualified.capsule,
    rank,
    documentIdentity: "owner",
    ...(verifiedUserSupportSource === undefined ? {} : { sourceRole: "user" as const }),
    ...(verifiedUserSupportSource === undefined
      ? {}
      : { verifiedUserSupportSource })
  });
}

function buildVerifiedUserSupportSource(
  qualified: Readonly<RecallQualifiedEvidence>
): Readonly<RecallVerifiedUserSupportSource> | undefined {
  return qualified.verified_user_projection
    ? Object.freeze({
      schema_version: 1 as const,
      source_role: "user" as const,
      projection_kind: "turn_projection" as const,
      evidence_ref: qualified.capsule.object_id,
      support_identity: null
    })
    : undefined;
}

function buildEvidenceRankById(
  matches: readonly Readonly<KeywordSearchResult>[]
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const match of matches) {
    ranks.set(
      match.object_id,
      Math.max(ranks.get(match.object_id) ?? 0, match.normalized_rank)
    );
  }
  return ranks;
}

function buildOwnerRankById(
  matches: readonly Readonly<KeywordSearchResult>[]
): ReadonlyMap<string, number> {
  return buildEvidenceRankById(matches.filter((match) =>
    match.matched_projection?.projection_kind !== "assistant_observation"
  ));
}

function buildProjectionMatchByKey(
  matches: readonly Readonly<KeywordSearchResult>[]
): ReadonlyMap<string, Readonly<KeywordSearchResult>> {
  const output = new Map<string, Readonly<KeywordSearchResult>>();
  for (const match of matches) {
    if (match.matched_projection === undefined) continue;
    const key = projectionMatchKey(match.object_id, match.matched_projection);
    const current = output.get(key);
    if (current === undefined || current.normalized_rank < match.normalized_rank) {
      output.set(key, match);
    }
  }
  return output;
}

function projectionMatchKey(
  objectId: string,
  projection: Readonly<RecallEvidenceSearchProjectionIdentity>
): string {
  return `${objectId}\u0000${projection.projection_kind}\u0000${projection.projection_id}`;
}

function selectQualifiedEvidenceCandidates(
  candidates: readonly QualifiedEvidenceCandidate[]
): readonly QualifiedEvidenceCandidate[] {
  const selected = new Map<string, QualifiedEvidenceCandidate>();
  for (const candidate of candidates) {
    const current = selected.get(candidate.capsule.object_id);
    if (current === undefined ||
        (current.recallText === undefined && candidate.recallText !== undefined) ||
        ((current.recallText === undefined) === (candidate.recallText === undefined) &&
          candidate.rank > current.rank)) {
      selected.set(candidate.capsule.object_id, candidate);
    }
  }
  return [...selected.values()];
}

async function loadBoundEvidenceRefsOrFallback(
  params: SemanticSupplementParams,
  evidenceRankById: ReadonlyMap<string, number>,
  directEvidence: readonly QualifiedEvidenceCandidate[]
): Promise<ReadonlySet<string> | null> {
  const findBoundEvidenceRefs =
    params.context.dependencies.memoryRepo.findBoundEvidenceRefs;
  if (findBoundEvidenceRefs === undefined) {
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    return null;
  }
  try {
    return new Set(await findBoundEvidenceRefs.call(
      params.context.dependencies.memoryRepo,
      params.workspaceId,
      directEvidence.map(({ capsule }) => capsule.object_id)
    ));
  } catch (error) {
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    throw error;
  }
}

async function admitMemoryEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceRankById: ReadonlyMap<string, number>
): Promise<void> {
  const findByEvidenceRefs =
    params.context.dependencies.memoryRepo.findByEvidenceRefs;
  if (evidenceRankById.size === 0 || findByEvidenceRefs === undefined) return;
  const memories = await findByEvidenceRefs.call(
    params.context.dependencies.memoryRepo,
    params.workspaceId,
    [...evidenceRankById.keys()]
  );
  for (const memory of memories) {
    if (!params.byId.has(memory.object_id)) continue;
    const bestRank = memory.evidence_refs.reduce(
      (best, ref) => Math.max(best, evidenceRankById.get(ref) ?? 0),
      0
    );
    if (bestRank <= 0) continue;
    params.evidenceFtsRanks.set(
      memory.object_id,
      Math.max(params.evidenceFtsRanks.get(memory.object_id) ?? 0, bestRank)
    );
    params.addCandidate(memory, "lexical", bestRank, "evidence_fts");
  }
}

async function admitDirectEvidenceMatches(
  params: SemanticSupplementParams,
  candidates: readonly QualifiedEvidenceCandidate[]
): Promise<void> {
  const findMemoryByIds = params.context.dependencies.memoryRepo.findByIds;
  if (candidates.length === 0 || findMemoryByIds === undefined) return;
  const collidingIds = new Set((await findMemoryByIds.call(
    params.context.dependencies.memoryRepo,
    params.workspaceId,
    candidates.map(({ capsule }) => capsule.object_id)
  )).map((memory) => memory.object_id));
  for (const candidate of candidates) {
    admitDirectEvidenceCandidate(params, collidingIds, candidate);
  }
}

function admitDirectEvidenceCandidate(
  params: SemanticSupplementParams,
  collidingIds: ReadonlySet<string>,
  candidate: QualifiedEvidenceCandidate
): void {
  const evidence = candidate.capsule;
  if (collidingIds.has(evidence.object_id) ||
      params.byId.has(evidence.object_id)) return;
  params.evidenceFtsRanks.set(evidence.object_id, candidate.rank);
  const entry = buildDirectEvidencePseudoMemoryEntry(
    evidence,
    candidate.rank,
    candidate.recallText
  );
    params.addCandidate(entry, "lexical", candidate.rank, "evidence_fts_direct", {
      objectKind: "evidence_capsule",
      answerRerankText: entry.content,
      evidenceDocumentIdentity: candidate.documentIdentity,
      ...(evidence.source_hash === null
        ? {}
        : { evidenceSourceIdentity: evidence.source_hash }),
      ...(candidate.sourceRole === undefined
        ? {}
        : { evidenceSourceRole: candidate.sourceRole }),
    ...(candidate.verifiedUserSupportSource === undefined
      ? {}
      : { verifiedUserSupportSource: candidate.verifiedUserSupportSource })
  });
}
