import { describe, expect, it, vi } from "vitest";
import { StorageTier, type RecallPolicy } from "@do-soul/alaya-protocol";
import { addSemanticSupplementCandidates } from
  "../../../recall/coarse-filter/coarse-filter-semantic.js";
import {
  EXPANDED_QUERY_RANK_DISCOUNT,
  queryHasObjectProbeSignal,
  scoreObjectProbeMatch
} from "../../../recall/coarse-filter/coarse-candidates.js";
import { createCoarseFilterState } from
  "../../../recall/coarse-filter/coarse-filter-pipeline.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import type { RecallRetrievalFieldBundle } from
  "../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { RunCoarseFilterContext } from
  "../../../recall/coarse-filter/coarse-filter.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

describe("semantic supplement admission order", () => {
  it("fetches FTS lanes concurrently but admits relaxed before expanded", async () => {
    const relaxed = createMemoryEntry({ object_id: "relaxed-only", content: "alpha router" });
    const overlap = createMemoryEntry({ object_id: "overlap", content: "alpha planner" });
    const expanded = createMemoryEntry({ object_id: "expanded-only", content: "routers" });
    const byId = new Map([
      [relaxed.object_id, relaxed],
      [overlap.object_id, overlap],
      [expanded.object_id, expanded]
    ]);
    const events: string[] = [];
    const admitted: string[] = [];
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const addCandidate: typeof state.addCandidate = (...args) => {
      admitted.push(`${args[0].object_id}:${args[3] ?? args[1]}`);
      return state.addCandidate(...args);
    };
    const queryProbes = {
      ...compileRecallQueryProbes("alpha router"),
      expanded_terms: ["routers", "planners"]
    };
    const retrievalFieldBundle = {
      searchMemoryKeyword: vi.fn(async ({ variant }) => {
        events.push(`${variant}:start`);
        await delay(variant === "lexical_expanded" ? 25 : 8);
        events.push(`${variant}:end`);
        if (variant === "lexical_relaxed") {
          return [
            { object_id: overlap.object_id, normalized_rank: 0.9 },
            { object_id: relaxed.object_id, normalized_rank: 0.8 }
          ];
        }
        return [
          { object_id: overlap.object_id, normalized_rank: 1 },
          { object_id: expanded.object_id, normalized_rank: 0.7 }
        ];
      }),
      searchEvidenceKeywords: vi.fn(async () => {
        events.push("evidence:start");
        await delay(5);
        events.push("evidence:end");
        return [];
      })
    } as unknown as RecallRetrievalFieldBundle;

    await addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {} as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes,
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId,
      addCandidate,
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle
    });

    expect(events.indexOf("lexical_expanded:start")).toBeLessThan(events.indexOf("lexical_relaxed:end"));
    expect(events.indexOf("evidence:start")).toBeLessThan(events.indexOf("lexical_relaxed:end"));
    expect(admitted).toEqual([
      "overlap:lexical",
      "relaxed-only:lexical",
      "overlap:lexical_expanded",
      "expanded-only:lexical_expanded"
    ]);
    expect(state.ftsRanks.get("overlap")).toBe(0.9);
    expect(state.ftsRanks.get("expanded-only")).toBeCloseTo(0.7 * EXPANDED_QUERY_RANK_DISCOUNT);
    expect(state.drafts.get("overlap")?.firstAdmissionPlane).toBe("lexical");
  });

  it("does not partially admit a completed lane when a concurrent lane fails", async () => {
    const relaxed = createMemoryEntry({ object_id: "relaxed-only", content: "alpha router" });
    const state = createCoarseFilterState({
      config: coarseFilterConfig(),
      winnerMemoryIds: new Set()
    });
    const retrievalFieldBundle = {
      searchMemoryKeyword: vi.fn(async ({ variant }) => {
        if (variant === "lexical_relaxed") {
          return [{ object_id: relaxed.object_id, normalized_rank: 1 }];
        }
        await delay(5);
        throw new Error("synthetic expanded lane failure");
      }),
      searchEvidenceKeywords: vi.fn(async () => [])
    } as unknown as RecallRetrievalFieldBundle;
    const queryProbes = {
      ...compileRecallQueryProbes("alpha router"),
      expanded_terms: ["routers"]
    };

    await expect(addSemanticSupplementCandidates({
      context: {
        warn: vi.fn(),
        dependencies: {} as RunCoarseFilterContext["dependencies"]
      },
      workspaceId: "workspace-1",
      config: coarseFilterConfig(),
      queryText: "alpha router",
      queryProbes,
      tier: StorageTier.HOT,
      tierScopedSearchEligible: true,
      byId: new Map([[relaxed.object_id, relaxed]]),
      addCandidate: state.addCandidate,
      ftsRanks: state.ftsRanks,
      trigramFtsRanks: state.trigramFtsRanks,
      evidenceFtsRanks: state.evidenceFtsRanks,
      evidenceFtsRanksPerRef: state.evidenceFtsRanksPerRef,
      evidenceProjectionMatchesByRef: state.evidenceProjectionMatchesByRef,
      retrievalFieldBundle
    })).rejects.toThrow(/synthetic expanded lane failure/u);

    expect(state.drafts).toHaveLength(0);
    expect(state.ftsRanks).toHaveLength(0);
  });
});

describe("object probe scan skip", () => {
  it("is a no-op when probes cannot score any HOT row", () => {
    const probes = compileRecallQueryProbes(null);
    const entry = createMemoryEntry({ object_id: "hot-1", content: "unrelated body" });
    expect(queryHasObjectProbeSignal(probes)).toBe(false);
    expect(scoreObjectProbeMatch(entry, probes)).toBe(0);
  });
});
