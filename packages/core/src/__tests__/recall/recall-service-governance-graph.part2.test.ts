import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type PathAnchorRef, type PathRelation } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from "../../recall/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPathRelation, createSlot, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
it("gates same-relation hop-2 chain extension while keeping heterogeneous associative reach", async () => {
    // The hop>=2 chain gate keys on the RAW relation_kind: a neighbor reached by
    // the same relation_kind as its parent (a single-relation lineage walk, e.g.
    // a derives_from provenance chain) is dropped from graph_expansion, while a
    // reach whose two hops use DIFFERENT relation_kinds that merely fold onto the
    // same tracked edge_type (co_recalled -> shares_entity, both -> `recalls`)
    // stays admitted as healthy heterogeneous convergence.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "hop1-derived",
        content: "First hop derived neighbor.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-same-chain",
        content: "Second hop same-relation chain extension.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop1-corecalled",
        content: "First hop co-recalled neighbor.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-heterogeneous",
        content: "Second hop heterogeneous associative reach.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // Chain A (same raw relation_kind twice -> hop-2 GATED):
    //   seed --derives_from--> hop1-derived --derives_from--> hop2-same-chain
    const seedToHop1Derived = createPathRelation({
      path_id: "p-chain-1",
      sourceId: "seed-memory",
      targetId: "hop1-derived",
      relationKind: "derives_from",
      strength: 1
    });
    const hop1ToSameChain = createPathRelation({
      path_id: "p-chain-2",
      sourceId: "hop1-derived",
      targetId: "hop2-same-chain",
      relationKind: "derives_from",
      strength: 1
    });
    // Chain B (different raw relation_kinds that both fold to `recalls` -> hop-2
    // ADMITTED): seed --co_recalled--> hop1-corecalled --shares_entity--> hop2-heterogeneous
    const seedToCorecalled = createPathRelation({
      path_id: "p-hetero-1",
      sourceId: "seed-memory",
      targetId: "hop1-corecalled",
      relationKind: "co_recalled",
      strength: 1
    });
    const corecalledToHetero = createPathRelation({
      path_id: "p-hetero-2",
      sourceId: "hop1-corecalled",
      targetId: "hop2-heterogeneous",
      relationKind: "shares_entity",
      strength: 1
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      const out: PathRelation[] = [];
      if (ids.has("seed-memory")) {
        out.push(seedToHop1Derived, seedToCorecalled);
      }
      if (ids.has("hop1-derived")) {
        out.push(hop1ToSameChain);
      }
      if (ids.has("hop1-corecalled")) {
        out.push(corecalledToHetero);
      }
      return out;
    });
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort: { findByAnchors }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 5,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    // hop-1 neighbors land on path_expansion; hop-1 is never gated.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop1-derived")
        ?.admission_planes
    ).toContain("path_expansion");
    // Same-relation hop-2 chain extension (derives_from -> derives_from) is gated
    // out of graph_expansion.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-same-chain")
        ?.admission_planes ?? []
    ).not.toContain("graph_expansion");
    // Heterogeneous associative reach (co_recalled -> shares_entity) stays on
    // graph_expansion even though both relation_kinds fold to `recalls`.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-heterogeneous")
        ?.admission_planes
    ).toContain("graph_expansion");
  });

it("does not count graph diagnostics for neighbors rejected by deterministic filters", async () => {
    // invariant: a path-backed neighbor whose dimension fails the deterministic
    // filter is never admitted to byId, so expandGraphFrontier (which only
    // traverses into admitted candidates) cannot fan it onto graph_expansion.
    // Wiring the unified pathExpansionPort exercises the real path-backed plane;
    // the retired graphExpansionPort no longer participates.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.PROJECT,
        domain_tags: ["repo"],
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "filtered-neighbor",
        dimension: MemoryDimension.PREFERENCE,
        scope_class: ScopeClass.PROJECT,
        domain_tags: ["repo"],
        content: "A graph neighbor that fails the deterministic dimension filter.",
        activation_score: 0.1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const seedToFilteredNeighbor = createPathRelation({
      path_id: "path-filtered-neighbor",
      sourceId: "seed-memory",
      targetId: "filtered-neighbor",
      relationKind: "derives_from",
      directionBias: "bidirectional_asymmetric",
      strength: 1
    });
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("seed-memory") || ids.has("filtered-neighbor")
          ? [seedToFilteredNeighbor]
          : [];
      })
    };
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          dimension_filter: [MemoryDimension.PROCEDURE]
        },
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 5,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("seed-memory");
    const filteredNeighbor = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "filtered-neighbor"
    );
    expect(filteredNeighbor?.admission_planes ?? []).not.toContain("graph_expansion");
    expect(result.diagnostics?.graph_expansion_plane_count_per_hop).toEqual([0, 0]);
    expect(result.diagnostics?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 0
    });
  });

it("applies conflict awareness to non-winner claim-like entries", async () => {
    const memories = [
      createMemoryEntry({ object_id: "winner-claim-1", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "memory-2", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 })
    ];
    // The slot's winner_claim_id is a ClaimForm ID; its source_object_refs links to the backing memory.
    const claimSourceRefs = { "claim-form-winner-1": ["winner-claim-1"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const winner = result.candidates.find((candidate) => candidate.object_id === "winner-claim-1");
    const loser = result.candidates.find((candidate) => candidate.object_id === "memory-2");

    expect(winner?.relevance_score).toBeGreaterThan(loser?.relevance_score ?? 0);
  });

it("exempts all source_object_refs from conflict penalty when a claim has multiple backing memories", async () => {
    // Claim "claim-form-winner-1" backs two memory entries; both should be treated as winner-backed
    // and must NOT receive the conflict_penalty regardless of which one is listed first.
    const memories = [
      createMemoryEntry({ object_id: "winner-mem-a", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "winner-mem-b", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 }),
      createMemoryEntry({ object_id: "non-winner-mem", dimension: MemoryDimension.PROCEDURE, activation_score: 0.8 })
    ];
    const claimSourceRefs = { "claim-form-winner-1": ["winner-mem-a", "winner-mem-b"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const winnerA = result.candidates.find((c) => c.object_id === "winner-mem-a");
    const winnerB = result.candidates.find((c) => c.object_id === "winner-mem-b");
    const nonWinner = result.candidates.find((c) => c.object_id === "non-winner-mem");

    // Both backing memories should score higher than the non-winner (which gets conflict_penalty)
    expect(winnerA?.relevance_score).toBeGreaterThan(nonWinner?.relevance_score ?? 0);
    expect(winnerB?.relevance_score).toBeGreaterThan(nonWinner?.relevance_score ?? 0);
  });
});
