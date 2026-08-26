import { describe, expect, it, vi } from "vitest";
import { StorageTier, type RecallPolicy } from "@do-soul/alaya-protocol";
import { addSemanticSupplementCandidates } from
  "../../../recall/coarse-filter/coarse-filter-semantic.js";
import { createCoarseFilterState } from
  "../../../recall/coarse-filter/coarse-filter-pipeline.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import type { RecallRetrievalFieldBundle } from
  "../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { RunCoarseFilterContext } from
  "../../../recall/coarse-filter/coarse-filter.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

function coarseFilterConfig(): Readonly<RecallPolicy>["coarse_filter"] {
  return {
    deterministic_match: {
      scope_filter: null,
      dimension_filter: null,
      domain_tag_filter: null
    },
    precomputed_rank: {
      max_candidates: 50,
      min_activation_score: null
    },
    semantic_supplement: {
      enabled: true,
      max_supplement: 8,
      embedding_enabled: false
    }
  } as Readonly<RecallPolicy>["coarse_filter"];
}

function ftsBundle(hits: readonly Readonly<{ object_id: string; normalized_rank: number }>[]) {
  return {
    searchMemoryKeyword: vi.fn(async ({ variant }) =>
      variant === "lexical_relaxed" ? hits : []
    ),
    searchEvidenceKeywords: vi.fn(async () => [])
  } as unknown as RecallRetrievalFieldBundle;
}

describe("semantic FTS hydrate-by-id admission", () => {
  it("admits an FTS hit that is absent from the initial byId after findByIds hydrate", async () => {
    const ftsOnly = createMemoryEntry({
      object_id: "fts-only",
      content: "alpha router"
    });
    const findByIds = vi.fn(async () => [ftsOnly]);
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const admitted: string[] = [];
    const addCandidate: typeof state.addCandidate = (...args) => {
      admitted.push(`${args[0].object_id}:${args[3] ?? args[1]}`);
      return state.addCandidate(...args);
    };

    await addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {
          memoryRepo: { findByIds }
        } as unknown as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes: compileRecallQueryProbes("alpha router"),
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId: new Map(),
      addCandidate,
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle: ftsBundle([
        { object_id: ftsOnly.object_id, normalized_rank: 0.9 }
      ])
    });

    expect(findByIds).toHaveBeenCalledWith("workspace-1", [ftsOnly.object_id]);
    expect(admitted).toEqual(["fts-only:lexical"]);
    expect(state.ftsRanks.get("fts-only")).toBe(0.9);
  });

  it("still skips an FTS hit absent from byId when findByIds is missing", async () => {
    const ftsOnly = createMemoryEntry({
      object_id: "fts-only",
      content: "alpha router"
    });
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const admitted: string[] = [];
    const addCandidate: typeof state.addCandidate = (...args) => {
      admitted.push(args[0].object_id);
      return state.addCandidate(...args);
    };

    await addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {} as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes: compileRecallQueryProbes("alpha router"),
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId: new Map(),
      addCandidate,
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle: ftsBundle([
        { object_id: ftsOnly.object_id, normalized_rank: 0.9 }
      ])
    });

    expect(admitted).toEqual([]);
    expect(state.ftsRanks.size).toBe(0);
  });

  it("does not admit a hydrated FTS hit whose storage_tier is not the recall tier", async () => {
    const warmHit = createMemoryEntry({
      object_id: "fts-warm",
      content: "alpha router",
      storage_tier: StorageTier.WARM
    });
    const findByIds = vi.fn(async () => [warmHit]);
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const admitted: string[] = [];

    await addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {
          memoryRepo: { findByIds }
        } as unknown as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes: compileRecallQueryProbes("alpha router"),
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId: new Map(),
      addCandidate: (entry, plane, score, source) => {
        admitted.push(`${entry.object_id}:${source ?? plane}`);
        return state.addCandidate(entry, plane, score, source);
      },
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle: ftsBundle([
        { object_id: warmHit.object_id, normalized_rank: 1 }
      ])
    });

    expect(findByIds).toHaveBeenCalled();
    expect(admitted).toEqual([]);
  });

  it("does not admit a hydrated FTS hit that is tombstoned or dormant", async () => {
    const tombstoned = createMemoryEntry({
      object_id: "fts-tombstoned",
      content: "alpha router",
      retention_state: "tombstoned"
    });
    const dormant = createMemoryEntry({
      object_id: "fts-dormant",
      content: "alpha router",
      lifecycle_state: "dormant"
    });
    const findByIds = vi.fn(async () => [tombstoned, dormant]);
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const admitted: string[] = [];

    await addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {
          memoryRepo: { findByIds }
        } as unknown as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes: compileRecallQueryProbes("alpha router"),
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId: new Map(),
      addCandidate: (entry, plane, score, source) => {
        admitted.push(`${entry.object_id}:${source ?? plane}`);
        return state.addCandidate(entry, plane, score, source);
      },
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle: ftsBundle([
        { object_id: tombstoned.object_id, normalized_rank: 1 },
        { object_id: dormant.object_id, normalized_rank: 0.9 }
      ])
    });

    expect(findByIds).toHaveBeenCalled();
    expect(admitted).toEqual([]);
  });
});
