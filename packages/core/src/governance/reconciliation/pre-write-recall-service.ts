import type { MemoryEntry, QueryAvailability } from "@do-soul/alaya-protocol";

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
import { readCandidateQuery, type CandidateQueryResult } from "./candidate-query-result.js";

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
  readonly availability: QueryAvailability;
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

interface StructuralProbeHit {
  readonly object_id: string;
  readonly family: PreWriteCandidateFamily;
}

export class PreWriteRecallService implements PreWriteRecallPort {
  public constructor(private readonly deps: PreWriteRecallServiceDependencies) {}

  public async recall(input: ReconciliationInput): Promise<PreWriteRecallResult> {
    const accumulators = new Map<string, CandidateAccumulator>();

    const lexical = await this.readLexicalHits(input.workspaceId, input.incomingContent);
    if (lexical.availability === "unavailable") {
      return this.unavailableResult(input.workspaceId, lexical.error, "lexical");
    }
    for (const hit of lexical.items) {
      addAccumulator(accumulators, hit.object_id, ["lexical"]);
    }

    const probes = await this.readStructuralProbeHits(input);
    if (probes.availability === "unavailable") {
      return this.unavailableResult(input.workspaceId, probes.error, "structural_probe");
    }
    for (const hit of probes.items) {
      addAccumulator(accumulators, hit.object_id, [hit.family]);
    }

    const structuralEntries = await this.readStructuralCandidates(input);
    if (structuralEntries.availability === "unavailable") {
      return this.unavailableResult(input.workspaceId, structuralEntries.error, "structural_scan");
    }
    for (const entry of structuralEntries.items) {
      addAccumulator(accumulators, entry.object_id, structuralFamiliesFor(input, entry));
    }

    const entries = await this.readCandidates(input.workspaceId, [...accumulators.keys()]);
    if (entries.availability === "unavailable") {
      return this.unavailableResult(input.workspaceId, entries.error, "candidate_fetch");
    }

    const scored = entries.items
      .filter((entry) => entry.lifecycle_state !== "archived")
      .map((entry) => scoreCandidate(input, entry, accumulators.get(entry.object_id)?.families ?? new Set()))
      .sort(compareCandidateNeighbors);
    const candidates = selectFinalCandidates(scored, this.deps.limit);

    return {
      availability: "ok",
      candidates,
      uncertainty: computeUncertainty(candidates),
      auditFeatures: {
        structural_scan_count: structuralEntries.items.length,
        retrieved_object_count: accumulators.size,
        candidate_count: candidates.length,
        family_counts: countFamilies(candidates)
      }
    };
  }

  private async readStructuralProbeHits(
    input: ReconciliationInput
  ): Promise<CandidateQueryResult<StructuralProbeHit>> {
    const hits: StructuralProbeHit[] = [];
    for (const probe of buildStructuralProbes(input)) {
      const result = await readCandidateQuery(() =>
        this.deps.lexicalSearch.searchByKeyword(input.workspaceId, probe.queryText, this.deps.limit)
      );
      if (result.availability === "unavailable") {
        return { availability: "unavailable", error: result.error };
      }
      for (const hit of result.items) {
        hits.push({ object_id: hit.object_id, family: probe.family });
      }
    }
    return { availability: "ok", items: hits };
  }

  private async readLexicalHits(
    workspaceId: string,
    queryText: string
  ): Promise<CandidateQueryResult<{ readonly object_id: string }>> {
    if (queryText.trim().length === 0) {
      return { availability: "ok", items: [] };
    }
    return await readCandidateQuery(() =>
      this.deps.lexicalSearch.searchByKeyword(workspaceId, queryText, this.deps.limit)
    );
  }

  private async readStructuralCandidates(
    input: ReconciliationInput
  ): Promise<CandidateQueryResult<Readonly<MemoryEntry>>> {
    const rows = await readCandidateQuery(() =>
      this.deps.memoryRepo.findByWorkspaceId(input.workspaceId, "hot", {
        limit: STRUCTURAL_SCAN_LIMIT,
        offset: 0
      })
    );
    if (rows.availability === "unavailable") {
      return rows;
    }
    const scored = rows.items
      .filter((entry) => entry.lifecycle_state !== "archived")
      .map((entry) => ({
        entry,
        score: scoreStructuralRecall(input, entry),
        families: structuralFamiliesFor(input, entry)
      }))
      .filter((item) => item.score > 0)
      .sort(compareStructuralCandidate);
    return { availability: "ok", items: selectStructuralEntries(scored, this.deps.limit) };
  }

  private async readCandidates(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<CandidateQueryResult<Readonly<MemoryEntry>>> {
    if (objectIds.length === 0) {
      return { availability: "ok", items: [] };
    }
    return await readCandidateQuery(() => this.deps.memoryRepo.findByIds(workspaceId, objectIds));
  }

  private unavailableResult(
    workspaceId: string,
    error: unknown,
    stage: string
  ): PreWriteRecallResult {
    this.deps.warn?.("pre-write recall unavailable", {
      workspace_id: workspaceId,
      stage,
      error: errorMessage(error)
    });
    return {
      availability: "unavailable",
      candidates: [],
      uncertainty: 1,
      auditFeatures: {
        failed: true,
        stage,
        error: errorMessage(error)
      }
    };
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
