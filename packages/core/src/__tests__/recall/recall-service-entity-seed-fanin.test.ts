import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  MemoryGovernanceEventType,
  ObjectLifecycleState,
  RecallContextEventType,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  SynthesisStatus,
  type EventLogEntry,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type SynthesisCapsule,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  computeRecallTokenEconomy,
  type RecallServiceDependencies
} from "../../recall/recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort
} from "../../recall/recall-service-types.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import { createActiveConstraint, createAnchor, createDependencies, createMemoryEntry, createPathRelation, createPreparedQueryHandle, createSlot, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  describe("entity_seed plane", () => {
    describe("multi-seed graph fan-in", () => {
      // see also: packages/core/src/recall/recall-service.ts addGraphExpansionCandidates
      // Pool B branch and RecallMultiSeedGraphFanInDiagnostics. The per-seed
      // BFS now traverses PathRelation rows, so a fan-in neighbor is a path
      // source -> target whose relation_kind names the equivalent edge type.
      const pathStub = (
        id: string,
        source: string,
        target: string,
        relationKind = "derives_from"
      ): PathRelation =>
        createPathRelation({
          path_id: id,
          sourceId: source,
          targetId: target,
          relationKind
        });
      // Builds a findByAnchors mock from a source-id -> outgoing-paths map. The
      // mock returns every path anchored on any requested object id so the
      // batched multi-hop lookups resolve the right neighbors.
      const findByAnchorsFrom = (
        bySource: Readonly<Record<string, readonly PathRelation[]>>
      ) =>
        vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return Object.entries(bySource).flatMap(([sourceId, paths]) =>
            ids.has(sourceId) ? paths : []
          );
        });

      it("with zero entity-derived seeds emits no multi_seed_graph_fan_in diagnostic", async () => {
        // invariant: when no entity is extracted from the query, the pooled
        // legacy path drives graph_expansion and the multi_seed_graph_fan_in
        // surface stays undefined (regression protection).
        const memories = [
          createMemoryEntry({
            object_id: "memory-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "anchor"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const service = new RecallService({
          ...dependencies
          // entityExtractionPort intentionally unwired
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "neutral query"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        expect(result.diagnostics?.multi_seed_graph_fan_in).toBeUndefined();
      });

      it("two non-overlapping entity seeds each fan independently with no dedup collisions", async () => {
        // invariant: each entity seed runs its own BFS so disjoint neighbor
        // sets land in the merged plane without dedup_collisions.
        const memories = [
          createMemoryEntry({
            object_id: "anchor-alpha",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "AlphaRouter binds writes."
          }),
          createMemoryEntry({
            object_id: "anchor-beta",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "BetaPlanner schedules tasks."
          }),
          createMemoryEntry({
            object_id: "neighbor-alpha",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of AlphaRouter outcomes"
          }),
          createMemoryEntry({
            object_id: "neighbor-beta",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of BetaPlanner outcomes"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "AlphaRouter") {
              return [{ object_id: "anchor-alpha", normalized_rank: 0.9 }];
            }
            if (query === "BetaPlanner") {
              return [{ object_id: "anchor-beta", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "anchor-alpha": [pathStub("edge-a", "anchor-alpha", "neighbor-alpha")],
          "anchor-beta": [pathStub("edge-b", "anchor-beta", "neighbor-beta")]
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
                surface: "AlphaRouter",
                normalized: "alpharouter",
                kind: "quoted" as const,
                confidence: 1.0
              }),
              Object.freeze({
                surface: "BetaPlanner",
                normalized: "betaplanner",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "AlphaRouter and BetaPlanner coordination"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(2);
        expect(fanIn?.dedup_collisions).toBe(0);
        // Each seed produced 1 candidate so the distribution is degenerate.
        expect(fanIn?.candidates_per_seed_p50).toBe(1);
        expect(fanIn?.candidates_per_seed_p95).toBe(1);
      });

      it("overlapping entity seeds dedup by max score and report dedup_collisions", async () => {
        // invariant: when the same memory is reached from two distinct
        // entity seeds, the merger keeps a single graph_expansion admission
        // with the higher score and counts each extra arrival as a
        // dedup_collision. No double-scoring across entity paths.
        const memories = [
          createMemoryEntry({
            object_id: "anchor-alpha",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "AlphaRouter binds writes."
          }),
          createMemoryEntry({
            object_id: "anchor-beta",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "BetaPlanner schedules tasks."
          }),
          createMemoryEntry({
            object_id: "shared-neighbor",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "downstream cross-cutting consumer"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "AlphaRouter") {
              return [{ object_id: "anchor-alpha", normalized_rank: 0.9 }];
            }
            if (query === "BetaPlanner") {
              return [{ object_id: "anchor-beta", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "anchor-alpha": [pathStub("edge-a-shared", "anchor-alpha", "shared-neighbor")],
          "anchor-beta": [pathStub("edge-b-shared", "anchor-beta", "shared-neighbor")]
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
                surface: "AlphaRouter",
                normalized: "alpharouter",
                kind: "quoted" as const,
                confidence: 1.0
              }),
              Object.freeze({
                surface: "BetaPlanner",
                normalized: "betaplanner",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "AlphaRouter BetaPlanner shared consumer"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        // The per-seed BFS still runs independently for each entity seed, so
        // the shared neighbor is reached twice and the merge records the
        // dedup_collision — this diagnostic is driven by Pool B traversal, not
        // by the final admit plane.
        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(2);
        expect(fanIn?.dedup_collisions).toBeGreaterThanOrEqual(1);

        // The shared neighbor is a direct hop-1 association off both entity
        // anchors (which are themselves draft seeds), so the unified plane
        // admits it once on path_expansion; the double-count guard keeps it
        // off graph_expansion. Admission planes are a set, so it appears once.
        const sharedDiag = result.diagnostics?.candidates.find(
          (c) => c.object_id === "shared-neighbor"
        );
        expect(sharedDiag?.admission_planes).toContain("path_expansion");
        expect(sharedDiag?.admission_planes).not.toContain("graph_expansion");
        const planeOccurrences = (sharedDiag?.admission_planes ?? []).filter(
          (plane) => plane === "path_expansion"
        ).length;
        expect(planeOccurrences).toBe(1);
      });

      it("caps merged fan-in candidates at the plane cap when one seed overruns", async () => {
        // invariant: MULTI_SEED_GRAPH_FAN_OUT_CAP (= DYNAMIC_RECALL_PLANE_CAP
        // = 240) bounds the admitted set after merge. We synthesize 260
        // neighbors reachable from a single entity seed; the post-cap
        // admission count must not exceed 240.
        const FAN_OUT_OVERFLOW = 260;
        const PLANE_CAP = 240;
        const neighborMemories = Array.from({ length: FAN_OUT_OVERFLOW }, (_, i) =>
          createMemoryEntry({
            object_id: `neighbor-${i.toString().padStart(3, "0")}`,
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: `neighbor ${i}`
          })
        );
        const memories = [
          createMemoryEntry({
            object_id: "fan-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "FanRouter binds many."
          }),
          ...neighborMemories
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "FanRouter") {
              return [{ object_id: "fan-anchor", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "fan-anchor": neighborMemories.map((neighbor, i) =>
            pathStub(`edge-${i}`, "fan-anchor", neighbor.object_id)
          )
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
                surface: "FanRouter",
                normalized: "fanrouter",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "FanRouter binding span"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        // The 260 neighbors are direct hop-1 associations off the entity-seed
        // anchor, so the unified plane admits them on path_expansion under the
        // same DYNAMIC_RECALL_PLANE_CAP. graph_expansion stays empty (its hop-1
        // would double-count), and neither associative plane exceeds the cap.
        const pathExpansionCount = (result.diagnostics?.candidates ?? []).filter(
          (c) => c.admission_planes.includes("path_expansion")
        ).length;
        const graphExpansionCount = (result.diagnostics?.candidates ?? []).filter(
          (c) => c.admission_planes.includes("graph_expansion")
        ).length;
        expect(pathExpansionCount).toBeLessThanOrEqual(PLANE_CAP);
        expect(graphExpansionCount).toBeLessThanOrEqual(PLANE_CAP);
        // Sanity: the per-seed BFS still ran (the diagnostic surface confirms
        // fan-in is active even though admission routed to path_expansion).
        expect(result.diagnostics?.multi_seed_graph_fan_in?.distinct_seeds).toBe(1);
      });

      it("single entity seed records distinct_seeds=1 with degenerate distribution", async () => {
        // invariant: even a single entity-derived seed activates the
        // multi-seed code path (distinct_seeds = 1). p50 / p95 collapse
        // to the per-seed count and dedup_collisions = 0.
        const memories = [
          createMemoryEntry({
            object_id: "solo-anchor",
            dimension: MemoryDimension.PROCEDURE,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "SoloRouter is unique."
          }),
          createMemoryEntry({
            object_id: "solo-neighbor",
            dimension: MemoryDimension.FACT,
            scope_class: ScopeClass.PROJECT,
            domain_tags: ["repo"],
            content: "consumer of SoloRouter"
          })
        ];
        const { dependencies } = createDependencies(memories);
        const searchByKeywordWithinObjectIds = vi.fn(
          async (_workspace: string, query: string) => {
            if (query === "SoloRouter") {
              return [{ object_id: "solo-anchor", normalized_rank: 0.9 }];
            }
            return [];
          }
        );
        const findByAnchors = findByAnchorsFrom({
          "solo-anchor": [pathStub("edge-solo", "solo-anchor", "solo-neighbor")]
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
                surface: "SoloRouter",
                normalized: "solorouter",
                kind: "quoted" as const,
                confidence: 1.0
              })
            ]
          }
        });

        const result = await service.recall({
          taskSurface: {
            ...createTaskSurface(),
            display_name: "SoloRouter binding scope"
          },
          workspaceId: "workspace-1",
          strategy: "chat"
        });

        const fanIn = result.diagnostics?.multi_seed_graph_fan_in;
        expect(fanIn).toBeDefined();
        expect(fanIn?.distinct_seeds).toBe(1);
        expect(fanIn?.dedup_collisions).toBe(0);
        expect(fanIn?.candidates_per_seed_p50).toBe(1);
        expect(fanIn?.candidates_per_seed_p95).toBe(1);
      });
    });
  });
});
