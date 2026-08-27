import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { uniqueStrings } from "../../expansion/path-relations.js";
import { recordEvidenceContextBulkFailure } from "./evidence-context-bulk-failure.js";
import {
  errorNameOf,
  toErrorMessage
} from "../../runtime/recall-service-helpers.js";
import {
  buildMemoryEvidenceContexts,
  emptyEvidenceContexts,
  stableEvidenceRefs
} from "./evidence-contexts-build.js";
import {
  loadCaptureFactFrameFormations,
  loadQualifiedFactKeys,
  loadQualifiedSemanticFormations
} from "./evidence-contexts-load.js";
import {
  MAX_REFS_PER_MEMORY,
  type CollectRecallEvidenceContextsParams,
  type RecallEvidenceContexts
} from "./evidence-contexts-types.js";

export type { RecallEvidenceContexts } from "./evidence-contexts-types.js";

export async function collectRecallEvidenceContexts(
  params: CollectRecallEvidenceContextsParams
): Promise<Readonly<RecallEvidenceContexts>> {
  const gistCandidates = collectRelevantCandidates(
    params.candidates,
    params.coarseEvidenceFtsRanks
  );
  const authorityCandidates = params.candidates.filter(
    (entry) => entry.evidence_refs.length > 0
  );
  const evidenceIds = uniqueStrings([
    ...collectRelevantEvidenceIds(
      gistCandidates,
      params.coarseEvidenceFtsRanksPerRef
    ),
    ...collectAuthorityEvidenceIds(authorityCandidates)
  ]);
  const captureOn = params.captureAnswerFeatures === true;
  const sharedIdSet = new Set(evidenceIds);
  const extraFactFrameIds = captureOn
    ? uniqueStrings(params.captureFactFrameObjectIds ?? [])
      .filter((id) => !sharedIdSet.has(id))
    : [];
  if (evidenceIds.length === 0 && extraFactFrameIds.length === 0) {
    return emptyEvidenceContexts([], captureOn);
  }
  const evidenceSearchPort = params.dependencies.evidenceSearchPort;
  if (evidenceIds.length > 0 && evidenceSearchPort?.findByIds === undefined) {
    return emptyEvidenceContexts(evidenceIds, captureOn);
  }
  try {
    const shared = evidenceIds.length === 0
      ? emptyEvidenceContexts([], captureOn)
      : await loadSharedEvidenceContexts(
        params,
        gistCandidates,
        authorityCandidates,
        evidenceIds,
        captureOn
      );
    return await mergeCaptureFactFrameFormations(params, shared, extraFactFrameIds);
  } catch (error) {
    recordEvidenceContextBulkFailure(params, error);
    return emptyEvidenceContexts(evidenceIds, captureOn);
  }
}

async function loadSharedEvidenceContexts(
  params: CollectRecallEvidenceContextsParams,
  gistCandidates: readonly Readonly<MemoryEntry>[],
  authorityCandidates: readonly Readonly<MemoryEntry>[],
  evidenceIds: readonly string[],
  captureOn: boolean
): Promise<Readonly<RecallEvidenceContexts>> {
  const [capsules, factKeys, semanticFormations] = await Promise.all([
    params.dependencies.evidenceSearchPort!.findByIds!(params.workspaceId, evidenceIds),
    loadQualifiedFactKeys(params, evidenceIds),
    loadQualifiedSemanticFormations(params, evidenceIds)
  ]);
  return buildMemoryEvidenceContexts(
    params.workspaceId,
    gistCandidates,
    authorityCandidates,
    params.coarseEvidenceFtsRanksPerRef,
    capsules,
    factKeys,
    semanticFormations.qualified,
    semanticFormations.unavailableEvidenceIds,
    captureOn
  );
}

async function mergeCaptureFactFrameFormations(
  params: CollectRecallEvidenceContextsParams,
  shared: Readonly<RecallEvidenceContexts>,
  extraIds: readonly string[]
): Promise<Readonly<RecallEvidenceContexts>> {
  if (extraIds.length === 0) return shared;
  try {
    const extras = await loadCaptureFactFrameFormations(params, extraIds);
    if (Object.keys(extras).length === 0) return shared;
    return Object.freeze({
      ...shared,
      factFrameFormationsByEvidenceId: Object.freeze({
        ...(shared.factFrameFormationsByEvidenceId ?? {}),
        ...extras
      })
    });
  } catch (error) {
    params.warn("capture fact-frame evidence lookup failed", {
      workspace_id: params.workspaceId,
      operation: "capture_fact_frame_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return shared;
  }
}

function collectRelevantCandidates(
  candidates: readonly Readonly<MemoryEntry>[],
  coarseEvidenceFtsRanks: Readonly<Record<string, number>>
): readonly Readonly<MemoryEntry>[] {
  return candidates.filter(
    (entry) =>
      entry.evidence_refs.length > 0 &&
      (coarseEvidenceFtsRanks[entry.object_id] ?? 0) > 0
  );
}

function collectRelevantEvidenceIds(
  candidates: readonly Readonly<MemoryEntry>[],
  ranksByRef: Readonly<Record<string, number>>
): readonly string[] {
  return uniqueStrings(candidates.flatMap((entry) =>
    selectRelevantEvidenceRefs(entry, ranksByRef)
  ));
}

function collectAuthorityEvidenceIds(
  candidates: readonly Readonly<MemoryEntry>[]
): readonly string[] {
  return uniqueStrings(candidates.flatMap((entry) =>
    stableEvidenceRefs(entry)
  ));
}

function selectRelevantEvidenceRefs(
  entry: Readonly<MemoryEntry>,
  ranksByRef: Readonly<Record<string, number>>
): readonly string[] {
  const hitRefs = entry.evidence_refs.filter((ref) => (ranksByRef[ref] ?? 0) > 0);
  if (hitRefs.length <= MAX_REFS_PER_MEMORY) return hitRefs;
  return [...hitRefs]
    .sort((left, right) => (ranksByRef[right] ?? 0) - (ranksByRef[left] ?? 0))
    .slice(0, MAX_REFS_PER_MEMORY);
}
