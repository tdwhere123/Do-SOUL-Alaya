import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  buildEvidenceSourceChunkIndex,
  buildEvidenceSourceCohortKeys,
  parseEvidenceSourceChunkRef,
  selectSourceProximitySeedDrafts,
  type CoarseCandidateDraft
} from "../coarse-filter/coarse-candidates.js";
import { uniqueStrings } from "./path-relations.js";
import {
  clamp01,
  compareMemoryEntries,
  errorNameOf,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import type { RecallServiceDependencies, RecallServiceWarnPort } from "../runtime/recall-service-types.js";
import type { CoarseCandidateAdder } from "./content-expansion.js";

type SourceChunkIndex = ReturnType<typeof buildEvidenceSourceChunkIndex>;
type SourceProximityNeighborCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly score: number;
}>;

type SourceProximityParams = Readonly<{
  readonly workspaceId: string;
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly admissionLimit: number;
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly robustSourceRefParsing?: boolean;
  readonly warn: RecallServiceWarnPort;
}>;

export async function addSourceProximityCandidates(
  params: SourceProximityParams
): Promise<Readonly<Record<string, string>>> {
  if (params.drafts.size === 0 || params.admissionLimit <= 0) {
    return Object.freeze({});
  }
  const seedDrafts = selectSourceProximitySeedDrafts(params.drafts, params.warn);
  if (seedDrafts.length === 0) {
    return Object.freeze({});
  }
  const robust = params.robustSourceRefParsing ?? false;
  const sourceRefsByMemoryId = await loadEvidenceSourceRefsByMemoryId({
    workspaceId: params.workspaceId, entries: params.tierMemories,
    evidenceSearchPort: params.evidenceSearchPort, warn: params.warn
  });
  const sourceCohortKeys = buildEvidenceSourceCohortKeys(
    params.tierMemories,
    sourceRefsByMemoryId,
    robust
  );
  const bySource = buildEvidenceSourceChunkIndex(params.tierMemories, sourceRefsByMemoryId, robust);
  if (bySource.size === 0) {
    return sourceCohortKeys;
  }
  const newlyAdmitted = new Set<string>();
  for (const seed of seedDrafts) {
    const candidates = collectSourceProximityNeighborCandidates(
      seed,
      sourceRefsByMemoryId,
      bySource,
      robust
    );
    if (
      admitSourceProximityNeighborCandidates(
        params,
        candidates,
        newlyAdmitted
      )
    ) {
      break;
    }
  }
  return sourceCohortKeys;
}

function collectSourceProximityNeighborCandidates(
  seed: Readonly<{ readonly draft: CoarseCandidateDraft; readonly strength: number }>,
  sourceRefsByMemoryId: ReadonlyMap<string, readonly string[]>,
  bySource: SourceChunkIndex,
  robust: boolean
): readonly SourceProximityNeighborCandidate[] {
  const neighborById = new Map<string, SourceProximityNeighborCandidate>();
  for (const ref of sourceRefsByMemoryId.get(seed.draft.entry.object_id) ?? seed.draft.entry.evidence_refs) {
    const parsed = parseEvidenceSourceChunkRef(ref, robust);
    if (parsed === null) {
      continue;
    }
    collectSourceChunkNeighbors(seed, neighborById, bySource.get(parsed.sourceKey) ?? [], parsed.chunkIndex);
  }
  return [...neighborById.values()]
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    )
    .slice(0, DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED);
}

function collectSourceChunkNeighbors(
  seed: Readonly<{ readonly draft: CoarseCandidateDraft; readonly strength: number }>,
  neighborById: Map<string, SourceProximityNeighborCandidate>,
  neighbors: readonly Readonly<{ readonly entry: Readonly<MemoryEntry>; readonly chunkIndex: number }>[],
  seedChunkIndex: number
): void {
  for (const neighbor of neighbors) {
    const score = scoreSourceProximityNeighbor(seed, neighbor, seedChunkIndex);
    if (score <= 0) {
      continue;
    }
    const current = neighborById.get(neighbor.entry.object_id);
    if (current === undefined || score > current.score) {
      neighborById.set(neighbor.entry.object_id, { entry: neighbor.entry, score });
    }
  }
}

function scoreSourceProximityNeighbor(
  seed: Readonly<{ readonly draft: CoarseCandidateDraft; readonly strength: number }>,
  neighbor: Readonly<{ readonly entry: Readonly<MemoryEntry>; readonly chunkIndex: number }>,
  seedChunkIndex: number
): number {
  if (neighbor.entry.object_id === seed.draft.entry.object_id) {
    return 0;
  }
  const distance = Math.abs(neighbor.chunkIndex - seedChunkIndex);
  if (distance > DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS) {
    return 0;
  }
  return clamp01(
    seed.strength * (1 - distance / (DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS + 1))
  );
}

function admitSourceProximityNeighborCandidates(
  params: Readonly<{
    readonly addCandidate: CoarseCandidateAdder;
    readonly admissionLimit: number;
  }>,
  candidates: readonly SourceProximityNeighborCandidate[],
  newlyAdmitted: Set<string>
): boolean {
  for (const candidate of candidates) {
    if (newlyAdmitted.size >= params.admissionLimit) {
      return true;
    }
    const admitted = params.addCandidate(
      candidate.entry,
      "source_proximity",
      candidate.score,
      "source_proximity"
    );
    if (admitted) {
      newlyAdmitted.add(candidate.entry.object_id);
    }
  }
  return false;
}

async function loadEvidenceSourceRefsByMemoryId(params: Readonly<{
  readonly workspaceId: string;
  readonly entries: readonly Readonly<MemoryEntry>[];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly warn: RecallServiceWarnPort;
}>): Promise<ReadonlyMap<string, readonly string[]>> {
  const sourceRefsByMemoryId = createInitialSourceRefsByMemoryId(params.entries);
  const evidenceSearchPort = params.evidenceSearchPort;
  const evidenceObjectIds = uniqueStrings(params.entries.flatMap((entry) => entry.evidence_refs));
  if (evidenceObjectIds.length === 0) {
    return sourceRefsByMemoryId;
  }
  if (evidenceSearchPort?.findSourceAnchorsByIds !== undefined) {
    try {
      const anchors = await evidenceSearchPort.findSourceAnchorsByIds(
        params.workspaceId,
        evidenceObjectIds
      );
      mergeArtifactRefsIntoSourceRefs(
        params.entries,
        sourceRefsByMemoryId,
        new Map(anchors.map((anchor) => [anchor.evidence_object_id, anchor.artifact_ref]))
      );
      return sourceRefsByMemoryId;
    } catch (error) {
      warnSourceAnchorFallback(params, "failed", error);
    }
  } else {
    warnSourceAnchorFallback(params, "unavailable");
  }
  if (evidenceSearchPort?.findByIds === undefined) {
    return sourceRefsByMemoryId;
  }
  try {
    const evidenceCapsules = await evidenceSearchPort.findByIds(params.workspaceId, evidenceObjectIds);
    const sourceRefByEvidenceId = buildArtifactRefByEvidenceId(params.workspaceId, evidenceCapsules);
    mergeArtifactRefsIntoSourceRefs(params.entries, sourceRefsByMemoryId, sourceRefByEvidenceId);
  } catch (error) {
    params.warn("evidence source-anchor lookup failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_source_anchor_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
  }

  return sourceRefsByMemoryId;
}

function warnSourceAnchorFallback(
  params: Readonly<{
    readonly workspaceId: string;
    readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
    readonly warn: RecallServiceWarnPort;
  }>,
  state: "failed" | "unavailable",
  error?: unknown
): void {
  const fullHydration = params.evidenceSearchPort?.findByIds !== undefined;
  params.warn(
    `evidence source-anchor id lookup ${state}; using ${fullHydration ? "full capsule hydration" : "embedded evidence refs"}`,
    {
      workspace_id: params.workspaceId,
      operation: "evidence_source_anchor_id_lookup",
      reason: state === "failed" ? "scalar_anchor_lookup_failed" : "scalar_anchor_port_unavailable",
      ...(error === undefined ? {} : {
        errorName: errorNameOf(error),
        error: toErrorMessage(error)
      })
    }
  );
}

function createInitialSourceRefsByMemoryId(
  entries: readonly Readonly<MemoryEntry>[]
): Map<string, readonly string[]> {
  const sourceRefsByMemoryId = new Map<string, readonly string[]>();
  for (const entry of entries) {
    sourceRefsByMemoryId.set(entry.object_id, uniqueStrings(entry.evidence_refs));
  }
  return sourceRefsByMemoryId;
}

function buildArtifactRefByEvidenceId(
  workspaceId: string,
  evidenceCapsules: readonly Readonly<{
    readonly workspace_id: string;
    readonly object_id: string;
    readonly physical_anchor?: Readonly<{ readonly artifact_ref?: string | null }> | null;
  }>[]
): ReadonlyMap<string, string> {
  const sourceRefByEvidenceId = new Map<string, string>();
  for (const evidence of evidenceCapsules) {
    if (evidence.workspace_id !== workspaceId) {
      continue;
    }
    const artifactRef = evidence.physical_anchor?.artifact_ref?.trim() ?? "";
    if (artifactRef.length > 0) {
      sourceRefByEvidenceId.set(evidence.object_id, artifactRef);
    }
  }
  return sourceRefByEvidenceId;
}

function mergeArtifactRefsIntoSourceRefs(
  entries: readonly Readonly<MemoryEntry>[],
  sourceRefsByMemoryId: Map<string, readonly string[]>,
  sourceRefByEvidenceId: ReadonlyMap<string, string>
): void {
  for (const entry of entries) {
    sourceRefsByMemoryId.set(
      entry.object_id,
      uniqueStrings([
        ...entry.evidence_refs,
        ...entry.evidence_refs
          .map((ref) => sourceRefByEvidenceId.get(ref))
          .filter((ref): ref is string => ref !== undefined)
      ])
    );
  }
}
