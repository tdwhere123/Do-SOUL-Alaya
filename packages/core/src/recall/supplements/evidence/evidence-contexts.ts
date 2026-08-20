import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { uniqueStrings } from "../../expansion/path-relations.js";
import { recordEvidenceContextBulkFailure } from "./evidence-context-bulk-failure.js";
import {
  buildMemoryEvidenceContexts,
  emptyEvidenceContexts,
  stableEvidenceRefs
} from "./evidence-contexts-build.js";
import {
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
  if (evidenceIds.length === 0) return emptyEvidenceContexts();
  const evidenceSearchPort = params.dependencies.evidenceSearchPort;
  if (evidenceSearchPort?.findByIds === undefined) {
    return emptyEvidenceContexts(evidenceIds);
  }
  try {
    const [capsules, factKeys, semanticFormations] = await Promise.all([
      evidenceSearchPort.findByIds(params.workspaceId, evidenceIds),
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
      semanticFormations.unavailableEvidenceIds
    );
  } catch (error) {
    recordEvidenceContextBulkFailure(params, error);
    return emptyEvidenceContexts(evidenceIds);
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
