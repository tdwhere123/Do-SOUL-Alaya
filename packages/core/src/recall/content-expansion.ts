import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SEED_CAP,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  buildEvidenceSourceChunkIndex,
  buildEvidenceSourceCohortKeys,
  countDomainTags,
  parseEvidenceSourceChunkRef,
  scoreDomainTagCluster,
  selectExpansionSeedEntries,
  selectPreferredExpansionSeedEntries,
  selectSourceProximitySeedDrafts,
  type CoarseCandidateDraft
} from "./coarse-candidates.js";
import { uniqueStrings } from "./path-relations.js";
import {
  clamp01,
  compareMemoryEntries,
  toErrorMessage
} from "./recall-service-helpers.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import type {
  RecallAdmissionPlane,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";
import {
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "./query-evidence-scoring.js";

type CoarseCandidateAdder = (
  entry: Readonly<MemoryEntry>,
  plane: RecallAdmissionPlane,
  structuralScore?: number,
  sourceChannel?: string
) => boolean;

export function addContentDerivedExpansionCandidates(params: Readonly<{
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly dynamicRecallPlaneCap: number;
  readonly dynamicRecallCohortRadius: number;
}>): void {
  const queryEvidenceEntries = params.tierMemories
    .map((entry) => Object.freeze({
      entry,
      score: scoreQueryEvidenceMatch(entry, params.queryProbes)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? compareMemoryEntries(left.entry, right.entry)
        : right.score - left.score
    )
    .slice(0, params.dynamicRecallPlaneCap);
  for (const candidate of queryEvidenceEntries) {
    params.addCandidate(candidate.entry, "lexical", candidate.score, "query_probe_lexical");
  }

  const seeds = selectExpansionSeedEntries(params.drafts, params.tierMemories)
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const structuralSeeds = selectPreferredExpansionSeedEntries(params.drafts)
    .slice(0, DYNAMIC_RECALL_SEED_CAP);
  const evidenceRefs = new Set<string>([
    ...params.queryProbes.evidence_refs,
    ...structuralSeeds.flatMap((entry) => entry.evidence_refs)
  ]);
  if (evidenceRefs.size > 0) {
    const entries = params.tierMemories
      .map((entry) => Object.freeze({
        entry,
        score: scoreEvidenceAnchorMatch(entry, evidenceRefs)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, params.dynamicRecallPlaneCap);
    for (const candidate of entries) {
      params.addCandidate(candidate.entry, "evidence_anchor", candidate.score, "evidence_anchor");
    }
  }

  const tagFrequency = countDomainTags(params.tierMemories);
  const queryTags = new Set(params.queryProbes.domain_tags);
  const seedTags = new Set(structuralSeeds.flatMap((entry) => entry.domain_tags));
  const domainTags = new Set([...queryTags, ...seedTags]);
  const commonTagLimit = Math.max(25, Math.floor(params.tierMemories.length * 0.2));
  if (domainTags.size > 0) {
    const entries = params.tierMemories
      .map((entry) => Object.freeze({
        entry,
        score: scoreDomainTagCluster(entry, domainTags, queryTags, tagFrequency, commonTagLimit)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, params.dynamicRecallPlaneCap);
    for (const candidate of entries) {
      params.addCandidate(candidate.entry, "domain_tag_cluster", candidate.score, "domain_tag_cluster");
    }
  }

  // invariant: cohort dominance guard runs per-branch. Each branch's
  // would-be admissions are compared against tier pool size; a branch
  // is skipped when its own coverage exceeds 50% of tierMemories. The
  // exact branch (query-attested surface_id/run_id) is admitted even
  // on saturated workspaces unless its own match-set alone exceeds
  // 50%; query attestation is stronger evidence than seed proximity.
  const querySurfaceIds = new Set(params.queryProbes.surface_ids);
  const queryRunIds = new Set(params.queryProbes.run_ids);
  const exactCohortMatches = params.tierMemories
    .filter((entry) =>
      (entry.surface_id !== null && querySurfaceIds.has(entry.surface_id)) ||
      (entry.run_id !== null && queryRunIds.has(entry.run_id))
    )
    .sort(compareMemoryEntries)
    .slice(0, params.dynamicRecallPlaneCap);
  const exactCohortRatio =
    params.tierMemories.length === 0
      ? 0
      : exactCohortMatches.length / params.tierMemories.length;
  if (exactCohortRatio <= 0.5) {
    for (const entry of exactCohortMatches) {
      params.addCandidate(entry, "session_surface_cohort", 0.8, "session_surface_cohort");
    }
  }

  if (structuralSeeds.length > 0) {
    const seedCohortByMemoryId = new Map<string, readonly Readonly<MemoryEntry>[]>();
    const seedCohortIds = new Set<string>();
    for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
      const cohort = params.tierMemories
        .filter((entry) =>
          (seed.surface_id !== null && entry.surface_id === seed.surface_id) ||
          (seed.run_id !== null && entry.run_id === seed.run_id)
        )
        .sort((left, right) => {
          const createdAtComparison = left.created_at.localeCompare(right.created_at);
          return createdAtComparison === 0
            ? left.object_id.localeCompare(right.object_id)
            : createdAtComparison;
        });
      seedCohortByMemoryId.set(seed.object_id, cohort);
      const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
      if (center < 0) {
        continue;
      }
      const start = Math.max(0, center - params.dynamicRecallCohortRadius);
      const end = Math.min(cohort.length, center + params.dynamicRecallCohortRadius + 1);
      for (const entry of cohort.slice(start, end)) {
        if (entry.object_id !== seed.object_id) {
          seedCohortIds.add(entry.object_id);
        }
      }
    }
    const seedCohortRatio =
      params.tierMemories.length === 0
        ? 0
        : seedCohortIds.size / params.tierMemories.length;
    if (seedCohortRatio <= 0.5) {
      for (const seed of seeds.slice(0, DYNAMIC_RECALL_SEED_CAP)) {
        const cohort = seedCohortByMemoryId.get(seed.object_id) ?? [];
        const center = cohort.findIndex((entry) => entry.object_id === seed.object_id);
        if (center < 0) {
          continue;
        }
        const start = Math.max(0, center - params.dynamicRecallCohortRadius);
        const end = Math.min(cohort.length, center + params.dynamicRecallCohortRadius + 1);
        for (const entry of cohort.slice(start, end)) {
          if (entry.object_id !== seed.object_id) {
            params.addCandidate(entry, "session_surface_cohort", 0.55, "session_surface_cohort");
          }
        }
      }
    }
  }
}

export async function addSourceProximityCandidates(params: Readonly<{
  readonly workspaceId: string;
  readonly tierMemories: readonly Readonly<MemoryEntry>[];
  readonly drafts: ReadonlyMap<string, CoarseCandidateDraft>;
  readonly addCandidate: CoarseCandidateAdder;
  readonly admissionLimit: number;
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly robustSourceRefParsing?: boolean;
  readonly warn: RecallServiceWarnPort;
}>): Promise<Readonly<Record<string, string>>> {
  if (params.drafts.size === 0 || params.admissionLimit <= 0) {
    return Object.freeze({});
  }

  const seedDrafts = selectSourceProximitySeedDrafts(params.drafts);
  if (seedDrafts.length === 0) {
    return Object.freeze({});
  }

  const robust = params.robustSourceRefParsing ?? false;
  const sourceRefsByMemoryId = await loadEvidenceSourceRefsByMemoryId({
    workspaceId: params.workspaceId,
    entries: params.tierMemories,
    evidenceSearchPort: params.evidenceSearchPort,
    warn: params.warn
  });
  const sourceCohortKeys = buildEvidenceSourceCohortKeys(params.tierMemories, sourceRefsByMemoryId, robust);
  const bySource = buildEvidenceSourceChunkIndex(params.tierMemories, sourceRefsByMemoryId, robust);
  if (bySource.size === 0) {
    return sourceCohortKeys;
  }

  const newlyAdmitted = new Set<string>();
  for (const seed of seedDrafts) {
    const neighborById = new Map<string, {
      readonly entry: Readonly<MemoryEntry>;
      readonly score: number;
    }>();
    for (const ref of sourceRefsByMemoryId.get(seed.draft.entry.object_id) ?? seed.draft.entry.evidence_refs) {
      const parsed = parseEvidenceSourceChunkRef(ref, robust);
      if (parsed === null) {
        continue;
      }
      const neighbors = bySource.get(parsed.sourceKey) ?? [];
      for (const neighbor of neighbors) {
        if (neighbor.entry.object_id === seed.draft.entry.object_id) {
          continue;
        }
        const distance = Math.abs(neighbor.chunkIndex - parsed.chunkIndex);
        if (distance > DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS) {
          continue;
        }
        const score = clamp01(
          seed.strength * (1 - distance / (DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS + 1))
        );
        if (score <= 0) {
          continue;
        }
        const current = neighborById.get(neighbor.entry.object_id);
        if (current === undefined || score > current.score) {
          neighborById.set(neighbor.entry.object_id, { entry: neighbor.entry, score });
        }
      }
    }

    const candidates = [...neighborById.values()]
      .sort((left, right) =>
        right.score === left.score
          ? compareMemoryEntries(left.entry, right.entry)
          : right.score - left.score
      )
      .slice(0, DYNAMIC_RECALL_SOURCE_PROXIMITY_NEIGHBORS_PER_SEED);
    for (const candidate of candidates) {
      if (newlyAdmitted.size >= params.admissionLimit) {
        return sourceCohortKeys;
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
  }
  return sourceCohortKeys;
}

async function loadEvidenceSourceRefsByMemoryId(params: Readonly<{
  readonly workspaceId: string;
  readonly entries: readonly Readonly<MemoryEntry>[];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly warn: RecallServiceWarnPort;
}>): Promise<ReadonlyMap<string, readonly string[]>> {
  const sourceRefsByMemoryId = new Map<string, readonly string[]>();
  for (const entry of params.entries) {
    sourceRefsByMemoryId.set(entry.object_id, uniqueStrings(entry.evidence_refs));
  }

  const evidenceSearchPort = params.evidenceSearchPort;
  if (evidenceSearchPort?.findByIds === undefined) {
    return sourceRefsByMemoryId;
  }

  const evidenceObjectIds = uniqueStrings(params.entries.flatMap((entry) => entry.evidence_refs));
  if (evidenceObjectIds.length === 0) {
    return sourceRefsByMemoryId;
  }

  try {
    const evidenceCapsules = await evidenceSearchPort.findByIds(params.workspaceId, evidenceObjectIds);
    const sourceRefByEvidenceId = new Map<string, string>();
    for (const evidence of evidenceCapsules) {
      if (evidence.workspace_id !== params.workspaceId) {
        continue;
      }
      const artifactRef = evidence.physical_anchor?.artifact_ref?.trim() ?? "";
      if (artifactRef.length > 0) {
        sourceRefByEvidenceId.set(evidence.object_id, artifactRef);
      }
    }
    for (const entry of params.entries) {
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
  } catch (error) {
    params.warn("evidence source-anchor lookup failed", {
      workspace_id: params.workspaceId,
      error: toErrorMessage(error)
    });
  }

  return sourceRefsByMemoryId;
}
