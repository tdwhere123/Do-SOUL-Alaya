import type { MemoryEntry } from "@do-soul/alaya-protocol";

import {
  errorMessage,
  type ReconciliationInput,
  type ReconciliationKeywordSearchPort,
  type ReconciliationMemoryRepoPort
} from "./reconciliation-service-internal.js";
import {
  buildStructuralProbes,
  compareCandidateNeighbors,
  computeUncertainty,
  countFamilies,
  scoreCandidate,
  scoreStructuralRecall,
  selectFinalCandidates,
  selectStructuralEntries,
  structuralFamiliesFor,
  STRUCTURAL_SCAN_LIMIT,
  compareStructuralCandidate
} from "./pre-write-recall-scoring.js";

export type PreWriteCandidateFamily =
  | "lexical"
  | "domain_tag"
  | "canonical_entity"
  | "typed_slot"
  | "temporal";

export type PreWriteRelationKind =
  | "same_as"
  | "refines"
  | "distinct"
  | "contradicts"
  | "supersedes"
  | "supports"
  | "unrelated";

export interface PreWriteRelationPosterior {
  readonly relation: PreWriteRelationKind;
  readonly probability: number;
}

export interface PreWriteCandidateNeighbor {
  readonly entry: Readonly<MemoryEntry>;
  readonly families: readonly PreWriteCandidateFamily[];
  readonly lexicalScore: number;
  readonly structuralScore: number;
  readonly tagScore: number;
  readonly entityScore: number;
  readonly slotScore: number;
  readonly temporalScore: number;
  readonly relationPosteriors: readonly PreWriteRelationPosterior[];
}

export interface PreWriteRecallResult {
  readonly candidates: readonly PreWriteCandidateNeighbor[];
  readonly uncertainty: number;
  readonly auditFeatures: Readonly<Record<string, unknown>>;
}

export interface PreWriteRecallPort {
  recall(input: ReconciliationInput): Promise<PreWriteRecallResult>;
}

export interface PreWriteRecallServiceDependencies {
  readonly lexicalSearch: ReconciliationKeywordSearchPort;
  readonly memoryRepo: ReconciliationMemoryRepoPort & {
    findByWorkspaceId(
      workspaceId: string,
      tier: MemoryEntry["storage_tier"],
      page: { readonly limit: number; readonly offset: number }
    ): Promise<readonly Readonly<MemoryEntry>[]>;
  };
  readonly limit: number;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

interface CandidateAccumulator {
  readonly objectId: string;
  readonly families: Set<PreWriteCandidateFamily>;
}

export class PreWriteRecallService implements PreWriteRecallPort {
  public constructor(private readonly deps: PreWriteRecallServiceDependencies) {}

  public async recall(input: ReconciliationInput): Promise<PreWriteRecallResult> {
    const accumulators = new Map<string, CandidateAccumulator>();

    await this.collectLexicalCandidates(input.workspaceId, input.incomingContent, accumulators);
    await this.collectStructuralProbeCandidates(input, accumulators);
    const structuralEntries = await this.loadStructuralCandidates(input);
    for (const entry of structuralEntries) {
      addAccumulator(accumulators, entry.object_id, structuralFamiliesFor(input, entry));
    }

    const entries = await this.loadCandidates(input.workspaceId, [...accumulators.keys()]);
    const scored = entries
      .filter((entry) => entry.lifecycle_state !== "archived")
      .map((entry) => scoreCandidate(input, entry, accumulators.get(entry.object_id)?.families ?? new Set()))
      .sort(compareCandidateNeighbors);
    const candidates = selectFinalCandidates(scored, this.deps.limit);

    return {
      candidates,
      uncertainty: computeUncertainty(candidates),
      auditFeatures: {
        structural_scan_count: structuralEntries.length,
        retrieved_object_count: accumulators.size,
        candidate_count: candidates.length,
        family_counts: countFamilies(candidates)
      }
    };
  }

  private async collectStructuralProbeCandidates(
    input: ReconciliationInput,
    accumulators: Map<string, CandidateAccumulator>
  ): Promise<void> {
    for (const probe of buildStructuralProbes(input)) {
      let hits: readonly { readonly object_id: string }[];
      try {
        hits = await this.deps.lexicalSearch.searchByKeyword(input.workspaceId, probe.queryText, this.deps.limit);
      } catch (error) {
        this.deps.warn?.("pre-write structural probe recall failed", {
          workspace_id: input.workspaceId,
          family: probe.family,
          error: errorMessage(error)
        });
        continue;
      }
      for (const hit of hits) {
        addAccumulator(accumulators, hit.object_id, [probe.family]);
      }
    }
  }

  private async collectLexicalCandidates(
    workspaceId: string,
    queryText: string,
    accumulators: Map<string, CandidateAccumulator>
  ): Promise<void> {
    if (queryText.trim().length === 0) {
      return;
    }
    let hits: readonly { readonly object_id: string }[];
    try {
      hits = await this.deps.lexicalSearch.searchByKeyword(workspaceId, queryText, this.deps.limit);
    } catch (error) {
      this.deps.warn?.("pre-write lexical recall failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return;
    }
    for (const hit of hits) {
      addAccumulator(accumulators, hit.object_id, ["lexical"]);
    }
  }

  private async loadStructuralCandidates(
    input: ReconciliationInput
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    try {
      const rows = await this.deps.memoryRepo.findByWorkspaceId(input.workspaceId, "hot", {
        limit: STRUCTURAL_SCAN_LIMIT,
        offset: 0
      });
      const scored = rows
        .filter((entry) => entry.lifecycle_state !== "archived")
        .map((entry) => ({
          entry,
          score: scoreStructuralRecall(input, entry),
          families: structuralFamiliesFor(input, entry)
        }))
        .filter((item) => item.score > 0)
        .sort(compareStructuralCandidate);
      return selectStructuralEntries(scored, this.deps.limit);
    } catch (error) {
      this.deps.warn?.("pre-write structural recall failed", {
        workspace_id: input.workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
  }

  private async loadCandidates(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    if (objectIds.length === 0) {
      return [];
    }
    try {
      return await this.deps.memoryRepo.findByIds(workspaceId, objectIds);
    } catch (error) {
      this.deps.warn?.("pre-write recall candidate fetch failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
  }
}

function addAccumulator(
  accumulators: Map<string, CandidateAccumulator>,
  objectId: string,
  families: readonly PreWriteCandidateFamily[]
): void {
  const existing = accumulators.get(objectId);
  if (existing === undefined) {
    accumulators.set(objectId, { objectId, families: new Set(families) });
    return;
  }
  for (const family of families) {
    existing.families.add(family);
  }
}
