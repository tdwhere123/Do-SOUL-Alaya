import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, type PathAnchorRef } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
describe("entity_seed plane", () => {
it("excludes a weak entity-only draft from graph_expansion fan-in (Fix-5b path 1)", async () => {
      // invariant: when the only non-activation admission is entity_seed
      // and the strongest entity confidence is below
      // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR (0.85), the draft must NOT
      // seed graph_expansion. Without this gate, a weak cjk_phrase /
      // proper_noun surface (confidence 0.35-0.7) admitted ONLY on
      // entity_seed would still feed selectExpansionSeedDrafts (path 1) and
      // compound surface manipulation across 1-hop neighbors.
      // see also: packages/core/src/recall/coarse-candidates.ts isWeakEntityOnlyDraft
      const memories = [
        createMemoryEntry({
          object_id: "memory-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-neighbor",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "Downstream consumer of MaterializationRouter outcomes."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeyword is only hit by the entity-seed pass (queried with
      // the surface "MaterializationRouter"). Returning nothing for any
      // other query isolates the entity_seed plane as the sole admission
      // path for memory-anchor — no lexical / object_probe / evidence
      // overlap can co-admit and rescue it past the weak-entity-only check.
      const searchByKeywordWithinObjectIds = vi.fn(
        async (_workspace: string, query: string) => {
          if (query === "MaterializationRouter") {
            return [{ object_id: "memory-anchor", normalized_rank: 0.9 }];
          }
          return [];
        }
      );
      // Path-backed plane: a directed path memory-anchor -> memory-neighbor so
      // that IF the weak entity-only draft were (wrongly) selected as a graph
      // BFS seed, the traversal would fan forward into memory-neighbor on
      // graph_expansion. source_to_target keeps memory-neighbor from pulling
      // memory-anchor backward onto path_expansion, so the only way the neighbor
      // reaches graph_expansion is memory-anchor seeding the traversal — which
      // the weak-entity-only gate must prevent.
      const anchorToNeighbor = createPathRelation({
        path_id: "path-anchor-neighbor",
        sourceId: "memory-anchor",
        targetId: "memory-neighbor",
        relationKind: "derives_from",
        directionBias: "source_to_target",
        strength: 1
      });
      const findByAnchors = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return ids.has("memory-anchor") || ids.has("memory-neighbor")
            ? [anchorToNeighbor]
            : [];
        }
      );

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        pathExpansionPort: { findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // 0.7 < 0.85 floor.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Deliberately avoid mentioning the entity surface so the
          // tier-level activation does not pre-admit memory-anchor on a
          // non-entity plane and accidentally satisfy the gate.
          display_name: "describe the binding"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-anchor"
      );
      // The anchor still admits on the entity_seed plane (diagnostics
      // distinguish the entity-seed-only case).
      expect(anchorDiag?.admission_planes).toContain("entity_seed");
      // invariant: the weak entity-only anchor must NEVER seed the path-backed
      // graph traversal, so its neighbor never reaches the graph_expansion plane.
      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes ?? []).not.toContain("graph_expansion");
      // invariant: the weak entity-only anchor is excluded from
      // selectExpansionSeedDrafts, so it never seeds the path-backed traversal
      // (the neighbor-absent-from-graph_expansion assertion above is the
      // authoritative behavioral guarantee). A findByAnchors call carrying
      // memory-anchor no longer implies frontier seeding: the post-coarse
      // governance-ceiling read passes every admitted candidate id (including
      // this entity-seed-admitted anchor) for an INBOUND-governance lookup
      // keyed on each candidate's target_anchor, not a traversal seed.
      // see also: recall-service.ts collectGovernanceCeilings (ceiling read)
      //   vs expandGraphFrontier / addPathExpansionCandidates (seed reads).
      const anchorSeededNeighborOnGraphExpansion =
        (neighborDiag?.admission_planes ?? []).includes("graph_expansion");
      expect(anchorSeededNeighborOnGraphExpansion).toBe(false);
    });

it("admits a weak entity into graph_expansion when a co-admitting plane carries it (Fix-5b)", async () => {
      // invariant: the weak-entity-only floor in selectExpansionSeedDrafts
      // ONLY excludes drafts whose sole non-activation admission is
      // entity_seed. A weak entity that is also admitted via lexical_fts
      // (or evidence_anchor, source_proximity, etc.) survives — the
      // co-admitting plane is independent corroboration that the surface
      // is meaningfully present in the corpus.
      // see also: packages/core/src/recall/coarse-candidates.ts isWeakEntityOnlyDraft
      const memories = [
        createMemoryEntry({
          object_id: "memory-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-neighbor",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["repo"],
          content: "Downstream consumer of MaterializationRouter outcomes."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeywordWithinObjectIds is called for both the lexical FTS
      // supplement (queryText) AND the entity-seed pass (entity surface).
      // The same hit shows up on BOTH lanes — entity_seed admits the
      // anchor AND lexical co-admits it. The weak-entity-only gate must
      // not fire because a non-entity plane co-admitted.
      const searchByKeywordWithinObjectIds = vi.fn(async () => [
        { object_id: "memory-anchor", normalized_rank: 0.9 }
      ]);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("memory-anchor")
          ? [
              createPathRelation({
                path_id: "path-1",
                sourceId: "memory-anchor",
                targetId: "memory-neighbor",
                relationKind: "derives_from"
              })
            ]
          : [];
      });

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        pathExpansionPort: { findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // Weak per Fix-5b's gate.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Include the surface so the lexical FTS supplement also returns
          // the anchor — that is the "co-admitting plane" survival path.
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-anchor"
      );
      // Confirm BOTH planes admitted — this is the precondition for the
      // co-admitting-plane survival branch to apply.
      expect(anchorDiag?.admission_planes).toContain("entity_seed");
      expect(anchorDiag?.admission_planes).toContain("lexical");
      // With co-admission present, the weak entity confidence does not block
      // expansion. The neighbor is a direct hop-1 association off the anchor,
      // so the unified plane admits it on path_expansion (the double-count
      // guard keeps it off graph_expansion).
      const neighborDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-neighbor"
      );
      expect(neighborDiag?.admission_planes).toContain("path_expansion");
      expect(findByAnchors).toHaveBeenCalledWith(
        "workspace-1",
        expect.arrayContaining([{ kind: "object", object_id: "memory-anchor" }])
      );
    });

it("does not let a weak entity-only draft leak into content_expansion (evidence_anchor + domain_tag_cluster)", async () => {
      // invariant: selectPreferredExpansionSeedEntries — which feeds the
      // evidence_anchor and domain_tag_cluster planes inside
      // addContentDerivedExpansionCandidates — must apply the same
      // weak-entity-only filter as selectExpansionSeedDrafts. Today
      // the entity_seed admission pass runs AFTER content expansion,
      // so the gap is latent at this exact call ordering. The filter
      // is defense-in-depth so any future reordering (or a follow-up
      // path that calls selectPreferredExpansionSeedEntries after
      // entity_seed has fired) cannot silently leak weak cjk_phrase /
      // proper_noun surfaces (confidence below
      // ENTITY_GRAPH_EXPANSION_CONFIDENCE_FLOOR) into evidence/tag
      // fan-out — the same surface manipulation the graph_expansion
      // floor blocks must stay blocked here.
      // This test asserts the externally-observable shape: a tier
      // memory hit only by the weak entity surface must not fan
      // evidence_anchor / domain_tag_cluster admissions to unrelated
      // tier memories that merely share evidence_refs / domain_tags.
      // see also: packages/core/src/recall/coarse-candidates.ts
      //   isWeakEntityOnlyDraft, selectPreferredExpansionSeedEntries
      const memories = [
        createMemoryEntry({
          object_id: "memory-weak-anchor",
          dimension: MemoryDimension.PROCEDURE,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["weak-anchor-rare-tag"],
          evidence_refs: ["evidence-weak-anchor-shared"],
          content: "MaterializationRouter binds memory creation."
        }),
        createMemoryEntry({
          object_id: "memory-evidence-target",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          // Disjoint tag set keeps domain_tag_cluster from co-admitting
          // this memory; only evidence_refs overlap with the weak anchor.
          domain_tags: ["unrelated-tag-A"],
          evidence_refs: ["evidence-weak-anchor-shared"],
          content: "Unrelated downstream observation."
        }),
        createMemoryEntry({
          object_id: "memory-tag-target",
          dimension: MemoryDimension.FACT,
          scope_class: ScopeClass.PROJECT,
          domain_tags: ["weak-anchor-rare-tag"],
          // Disjoint evidence_refs keeps evidence_anchor from
          // co-admitting; only the rare tag overlaps with the anchor.
          evidence_refs: ["evidence-unrelated"],
          content: "Unrelated tagged observation."
        })
      ];
      const { dependencies } = createDependencies(memories);
      // searchByKeywordWithinObjectIds returns only the weak anchor on
      // the entity surface "MaterializationRouter" — no other lane hits
      // memory-weak-anchor, so its sole non-activation admission is
      // entity_seed.
      const searchByKeywordWithinObjectIds = vi.fn(
        async (_workspace: string, query: string) => {
          if (query === "MaterializationRouter") {
            return [{ object_id: "memory-weak-anchor", normalized_rank: 0.9 }];
          }
          return [];
        }
      );

      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds
        },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "proper_noun" as const,
              // 0.7 < 0.85 floor → isWeakEntityOnlyDraft = true.
              confidence: 0.7
            })
          ]
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          // Avoid mentioning the entity surface so the lexical lane
          // does not co-admit and rescue memory-weak-anchor.
          display_name: "describe the binding"
        },
        workspaceId: "workspace-1",
        strategy: "chat"
      });

      const anchorDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-weak-anchor"
      );
      // Precondition: weak anchor still admits on the entity_seed plane.
      expect(anchorDiag?.admission_planes).toContain("entity_seed");

      const evidenceTargetDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-evidence-target"
      );
      const tagTargetDiag = result.diagnostics?.candidates.find(
        (c) => c.object_id === "memory-tag-target"
      );
      // invariant under test: the weak entity-only anchor must NOT
      // seed evidence_anchor or domain_tag_cluster expansion. Either
      // the targets are not admitted at all, or their admission_planes
      // do not include the content-expansion planes seeded by the
      // weak anchor.
      expect(evidenceTargetDiag?.admission_planes ?? []).not.toContain("evidence_anchor");
      expect(tagTargetDiag?.admission_planes ?? []).not.toContain("domain_tag_cluster");
    });
});
});
