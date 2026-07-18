import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { buildEvidenceSearchQueries } from "../../coarse-filter/coarse-candidates.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import {
  clamp01,
  compareMemoryEntries
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallServiceDependencies
} from "../../runtime/recall-service-types.js";
import {
  scoreEvidenceAnchorMatch,
  scoreQueryEvidenceMatch
} from "../../scoring/query-evidence-scoring.js";

type SynthesisSearchPort = NonNullable<RecallServiceDependencies["synthesisSearchPort"]>;
type SynthesisSearchRow = Awaited<ReturnType<SynthesisSearchPort["findByIds"]>>[number];
type SynthesisChildCandidate = Readonly<{
  readonly candidate: Readonly<CoarseRecallCandidate>;
  readonly synthesisRank: number;
}>;
type RankedSynthesisChildRef = Readonly<{
  readonly synthesisId: string;
  readonly memoryId: string;
  readonly synthesisRank: number;
}>;

const SYNTHESIS_CHILDREN_PER_CAPSULE = 20;
const SYNTHESIS_CHILDREN_GLOBAL_CAP = 40;

export async function collectSynthesisChildCandidates(params: Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "memoryRepo">;
  readonly workspaceId: string;
  readonly queryText: string;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly synthesisSearchPort: SynthesisSearchPort;
  readonly limit: number;
}>): Promise<Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
}>> {
  const rankById = await collectSynthesisRankById(params);
  if (rankById.size === 0) return emptySynthesisChildren();
  const synthesisRows = await params.synthesisSearchPort.findByIds(
    params.workspaceId,
    [...rankById.keys()]
  );
  const candidates = await buildSynthesisChildren(params, synthesisRows, rankById);
  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate) => candidate.candidate)),
    synthesisFtsRanks: buildSynthesisChildFtsRanks(candidates)
  });
}

async function collectSynthesisRankById(
  params: Parameters<typeof collectSynthesisChildCandidates>[0]
): Promise<ReadonlyMap<string, number>> {
  const rankById = new Map<string, number>();
  const queryResults = await Promise.allSettled(
    buildEvidenceSearchQueries(params.queryText, params.queryProbes).map((query) =>
      params.synthesisSearchPort.searchByKeyword(params.workspaceId, query, params.limit)
    )
  );
  for (const result of queryResults) {
    if (result.status === "rejected") throw result.reason;
    for (const match of result.value) {
      rankById.set(
        match.object_id,
        Math.max(rankById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
      );
    }
  }
  return rankById;
}

async function buildSynthesisChildren(
  params: Parameters<typeof collectSynthesisChildCandidates>[0],
  synthesisRows: readonly Readonly<SynthesisSearchRow>[],
  rankById: ReadonlyMap<string, number>
): Promise<readonly SynthesisChildCandidate[]> {
  if (typeof params.dependencies.memoryRepo.findByIds !== "function") return Object.freeze([]);
  const childRefs = collectSynthesisChildRefs(params.workspaceId, synthesisRows, rankById);
  if (childRefs.length === 0) return Object.freeze([]);
  const childRows = await params.dependencies.memoryRepo.findByIds(
    params.workspaceId,
    uniqueMemoryIds(childRefs)
  );
  return buildResolvedSynthesisChildren(params, childRefs, childRows);
}

function collectSynthesisChildRefs(
  workspaceId: string,
  synthesisRows: readonly Readonly<SynthesisSearchRow>[],
  rankById: ReadonlyMap<string, number>
): readonly RankedSynthesisChildRef[] {
  const refs: RankedSynthesisChildRef[] = [];
  for (const synthesis of synthesisRows) {
    if (synthesis.workspace_id !== workspaceId) continue;
    const synthesisRank = clamp01(rankById.get(synthesis.object_id) ?? 0);
    const seenInCapsule = new Set<string>();
    for (const rawMemoryId of synthesis.source_memory_refs) {
      const memoryId = rawMemoryId.trim();
      if (memoryId.length === 0 || seenInCapsule.has(memoryId)) continue;
      seenInCapsule.add(memoryId);
      refs.push(Object.freeze({ synthesisId: synthesis.object_id, memoryId, synthesisRank }));
    }
  }
  return Object.freeze(refs.sort(compareSynthesisChildRefs));
}

function compareSynthesisChildRefs(
  left: RankedSynthesisChildRef,
  right: RankedSynthesisChildRef
): number {
  return right.synthesisRank - left.synthesisRank ||
    left.synthesisId.localeCompare(right.synthesisId) ||
    left.memoryId.localeCompare(right.memoryId);
}

function uniqueMemoryIds(refs: readonly RankedSynthesisChildRef[]): readonly string[] {
  return Object.freeze(Array.from(new Set(refs.map((ref) => ref.memoryId))));
}

function buildResolvedSynthesisChildren(
  params: Pick<Parameters<typeof collectSynthesisChildCandidates>[0], "queryProbes" | "workspaceId">,
  childRefs: readonly RankedSynthesisChildRef[],
  childRows: readonly Readonly<MemoryEntry>[]
): readonly SynthesisChildCandidate[] {
  const childById = new Map(childRows.map((child) => [child.object_id, child]));
  const acceptedByCapsule = new Map<string, number>();
  const candidateById = new Map<string, SynthesisChildCandidate>();
  for (const childRef of childRefs) {
    if ((acceptedByCapsule.get(childRef.synthesisId) ?? 0) >= SYNTHESIS_CHILDREN_PER_CAPSULE) continue;
    const child = childById.get(childRef.memoryId);
    if (child === undefined || !isUsableSynthesisChild(child, params.workspaceId)) continue;
    acceptedByCapsule.set(childRef.synthesisId, (acceptedByCapsule.get(childRef.synthesisId) ?? 0) + 1);
    const specificity = scoreSynthesisChildSpecificity(child, params.queryProbes);
    const next = buildSynthesisChildCandidate(child, childRef.synthesisRank, specificity);
    const current = candidateById.get(child.object_id);
    if (current === undefined || next.synthesisRank > current.synthesisRank) {
      candidateById.set(child.object_id, next);
    }
  }
  return Object.freeze(
    [...candidateById.values()].sort(compareSynthesisChildCandidates)
      .slice(0, SYNTHESIS_CHILDREN_GLOBAL_CAP)
  );
}

function isUsableSynthesisChild(child: Readonly<MemoryEntry>, workspaceId: string): boolean {
  return child.workspace_id === workspaceId && child.lifecycle_state === "active";
}

function scoreSynthesisChildSpecificity(
  child: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  return clamp01(
    scoreQueryEvidenceMatch(child, queryProbes) +
      0.5 * scoreEvidenceAnchorMatch(child, new Set(queryProbes.evidence_refs))
  );
}

function buildSynthesisChildCandidate(
  child: Readonly<MemoryEntry>,
  synthesisRank: number,
  specificity: number
): SynthesisChildCandidate {
  const childRank = clamp01(synthesisRank * Math.max(specificity, 0.05));
  return Object.freeze({
    candidate: Object.freeze({
      entry: child,
      originPlane: "workspace_local" as const,
      sourceChannel: "synthesis_child",
      sourceChannels: Object.freeze(["synthesis_child", "synthesis_fts"]),
      admissionPlanes: Object.freeze(["synthesis_child" as const]),
      firstAdmissionPlane: "synthesis_child" as const,
      structuralScore: 0
    }),
    synthesisRank: childRank
  });
}

function compareSynthesisChildCandidates(
  left: SynthesisChildCandidate,
  right: SynthesisChildCandidate
): number {
  const delta = right.synthesisRank - left.synthesisRank;
  return delta !== 0 ? delta : compareMemoryEntries(left.candidate.entry, right.candidate.entry);
}

function buildSynthesisChildFtsRanks(
  candidates: readonly SynthesisChildCandidate[]
): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(candidates.map((candidate) => [
    candidate.candidate.entry.object_id,
    candidate.synthesisRank
  ] as const)));
}

function emptySynthesisChildren() {
  return Object.freeze({
    candidates: Object.freeze([]),
    synthesisFtsRanks: Object.freeze({})
  });
}
