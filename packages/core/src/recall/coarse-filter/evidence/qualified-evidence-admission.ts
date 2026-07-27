import {
  hasGardenSourceTurnFallbackV2ReceiptFormat,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import type {
  RecallVerifiedUserSupportSource
} from "../../query/recall-answer-support-observation.js";
import type {
  SemanticSupplementParams
} from "../coarse-filter-semantic.js";
import {
  buildDirectEvidencePseudoMemoryEntry,
  isDirectRecallEvidence
} from "./direct-evidence-candidate.js";

interface QualifiedEvidenceCandidate {
  readonly capsule: Readonly<EvidenceCapsule>;
  readonly verifiedUserSupportSource?: Readonly<RecallVerifiedUserSupportSource>;
}

export async function admitQualifiedEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceRankById: ReadonlyMap<string, number>
): Promise<void> {
  const candidates = await loadQualifiedEvidenceOrFallback(params, evidenceRankById);
  if (candidates === null) return;
  const direct = candidates.filter(({ capsule }) =>
    isDirectRecallEvidence(capsule, params.workspaceId)
  );
  const boundRefs = await loadBoundEvidenceRefsOrFallback(
    params,
    evidenceRankById,
    direct
  );
  if (boundRefs === null) return;
  const unbound = direct.filter(({ capsule }) => !boundRefs.has(capsule.object_id));
  const unboundIds = new Set(unbound.map(({ capsule }) => capsule.object_id));
  const ordinaryRanks = new Map(
    [...evidenceRankById].filter(([objectId]) => !unboundIds.has(objectId))
  );
  await admitMemoryEvidenceMatches(params, ordinaryRanks);
  await admitDirectEvidenceMatches(params, evidenceRankById, unbound);
}

async function loadQualifiedEvidenceOrFallback(
  params: SemanticSupplementParams,
  evidenceRankById: ReadonlyMap<string, number>
): Promise<readonly QualifiedEvidenceCandidate[] | null> {
  const findQualified =
    params.context.dependencies.evidenceSearchPort?.findRecallQualifiedByIds;
  if (findQualified === undefined) {
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    return null;
  }
  try {
    const capsules = await findQualified.call(
      params.context.dependencies.evidenceSearchPort,
      params.workspaceId,
      [...evidenceRankById.keys()]
    );
    return capsules.map(projectQualifiedEvidenceCandidate);
  } catch (error) {
    await admitMemoryEvidenceMatches(params, evidenceRankById);
    throw error;
  }
}

function projectQualifiedEvidenceCandidate(
  capsule: Readonly<EvidenceCapsule>
): Readonly<QualifiedEvidenceCandidate> {
  // Receipt verification belongs to findRecallQualifiedByIds; format only
  // identifies whether that verified receipt carries a complete User projection.
  const verifiedUserSupportSource = hasVerifiedUserProjection(capsule)
    ? Object.freeze({
      schema_version: 1 as const,
      source_role: "user" as const,
      projection_kind: "turn_projection" as const,
      evidence_ref: capsule.object_id,
      support_identity: null
    })
    : undefined;
  return Object.freeze({
    capsule,
    ...(verifiedUserSupportSource === undefined
      ? {}
      : { verifiedUserSupportSource })
  });
}

function hasVerifiedUserProjection(capsule: Readonly<EvidenceCapsule>): boolean {
  return (capsule.excerpt?.trim().length ?? 0) > 0 &&
    hasGardenSourceTurnFallbackV2ReceiptFormat({
      artifact_ref: capsule.physical_anchor?.artifact_ref ?? null,
      source_hash: capsule.source_hash
    });
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
  evidenceRankById: ReadonlyMap<string, number>,
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
    admitDirectEvidenceCandidate(params, evidenceRankById, collidingIds, candidate);
  }
}

function admitDirectEvidenceCandidate(
  params: SemanticSupplementParams,
  evidenceRankById: ReadonlyMap<string, number>,
  collidingIds: ReadonlySet<string>,
  candidate: QualifiedEvidenceCandidate
): void {
  const evidence = candidate.capsule;
  const rank = evidenceRankById.get(evidence.object_id);
  if (rank === undefined || collidingIds.has(evidence.object_id) ||
      params.byId.has(evidence.object_id)) return;
  params.evidenceFtsRanks.set(evidence.object_id, rank);
  const entry = buildDirectEvidencePseudoMemoryEntry(evidence, rank);
  params.addCandidate(entry, "lexical", rank, "evidence_fts_direct", {
    objectKind: "evidence_capsule",
    answerRerankText: entry.content,
    ...(candidate.verifiedUserSupportSource === undefined
      ? {}
      : { verifiedUserSupportSource: candidate.verifiedUserSupportSource })
  });
}
