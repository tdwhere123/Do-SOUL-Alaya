import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, SynthesisStatus, type MemoryEntry, type PathAnchorRef, type SynthesisCapsule } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from "../../recall/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
describe("structural delivery reserve", () => {
  beforeEach(() => {
    process.env.ALAYA_RECALL_STRUCTURAL_RESERVE = "on";
  });
  afterEach(() => {
    delete process.env.ALAYA_RECALL_STRUCTURAL_RESERVE;
  });
// Build the anchor + lexical multi-stream decoys + a structural gold that
    // expands off the anchor via path_expansion. The anchor is the entity seed;
    // each decoy holds a strong path so the gold ranks LOW on the path_expansion
    // stream — a single-stream structural candidate with a poor stream rank is
    // exactly the burial reserveStructuralDeliverySlots rescues.
    const buildStructuralFixture = (params: {
      readonly decoyCount: number;
      readonly goldPathStrength: number;
    }) => {
      const anchor = createMemoryEntry({
        object_id: "memory-anchor",
        content: "MaterializationRouter binds memory creation strongly.",
        dimension: MemoryDimension.PROCEDURE,
        domain_tags: ["repo"]
      });
      const decoys = Array.from({ length: params.decoyCount }, (_unused, index) =>
        createMemoryEntry({
          object_id: `decoy-${index + 1}`,
          content: "MaterializationRouter binds memory creation strongly here.",
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo"]
        })
      );
      const gold = createMemoryEntry({
        object_id: "memory-gold",
        content: "Quiet downstream consumer with no query overlap zzz.",
        dimension: MemoryDimension.FACT,
        domain_tags: ["unrelated-domain"],
        activation_score: 0.05
      });
      const findByAnchors: RecallServicePathExpansionPort["findByAnchors"] = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          if (!ids.has("memory-anchor")) {
            return [];
          }
          return [
            ...decoys.map((decoy, index) =>
              createPathRelation({
                path_id: `path-${decoy.object_id}`,
                sourceId: "memory-anchor",
                targetId: decoy.object_id,
                relationKind: "supports",
                recallBias: 1 - index * 0.05,
                strength: 1 - index * 0.05
              })
            ),
            createPathRelation({
              path_id: "path-gold",
              sourceId: "memory-anchor",
              targetId: "memory-gold",
              relationKind: "supports",
              recallBias: params.goldPathStrength,
              strength: params.goldPathStrength,
              stabilityClass: "normal"
            })
          ];
        }
      );
      return { anchor, decoys, gold, findByAnchors };
    };

const buildStructuralService = (params: {
      readonly anchor: Readonly<MemoryEntry>;
      readonly decoys: readonly Readonly<MemoryEntry>[];
      readonly gold: Readonly<MemoryEntry>;
      readonly findByAnchors: RecallServicePathExpansionPort["findByAnchors"];
      readonly synthesisRows?: readonly SynthesisCapsule[];
    }) => {
      const memories = [params.anchor, ...params.decoys, params.gold];
      const { dependencies } = createDependencies(memories);
      const lexicalRows = [params.anchor, ...params.decoys].map((memory, index) => ({
        object_id: memory.object_id,
        normalized_rank: 1 - index * 0.02
      }));
      // The active lexical lane is searchByKeywordWithinObjectIds (preferred over
      // searchByKeyword when both are wired). The anchor + every decoy hold strong
      // lexical ranks; memory-gold holds the WEAKEST hit (0.04) so it ranks last
      // in the lexical_fts stream. Under the corrected I-1 contract a structural
      // gold the reserve rescues must be relevance-bearing (not a pure
      // membership-reached sibling), but the bottom-ranked 0.04 hit keeps the gold
      // topology-DOMINATED and buried below the flat cut — the decoys out-fuse it
      // on both the lexical and path lanes.
      const withinObjectIdRows = [
        { object_id: "memory-anchor", normalized_rank: 0.9 },
        ...params.decoys.map((decoy, index) => ({
          object_id: decoy.object_id,
          normalized_rank: 0.88 - index * 0.02
        })),
        { object_id: "memory-gold", normalized_rank: 0.04 }
      ];
      return new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeyword: vi.fn(async () => lexicalRows),
          searchByKeywordWithinObjectIds: vi.fn(async (_workspaceId: string, query: string) =>
            query.toLowerCase().includes("materializationrouter") ? withinObjectIdRows : []
          )
        },
        pathExpansionPort: { findByAnchors: params.findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "quoted" as const,
              confidence: 1.0
            })
          ]
        },
        ...(params.synthesisRows
          ? {
              synthesisSearchPort: {
                searchByKeyword: vi.fn(async () =>
                  params.synthesisRows!.map((row, index) => ({
                    object_id: row.object_id,
                    normalized_rank: 1 - index * 0.1
                  }))
                ),
                findByIds: vi.fn(async () => params.synthesisRows!)
              }
            }
          : {})
      });
    };

const runStructuralRecall = (service: RecallService, maxEntries: number) => {
      const policy = overridePolicy(
        service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
        {
          // Widen the lexical supplement so a structural gold's bottom-ranked weak
          // lexical co-admission (its gold-blind relevance signal under the
          // corrected I-1 contract) is not dropped by the default top-N cut. The
          // gold still ranks last in the lexical_fts stream and stays buried.
          coarse_filter: {
            deterministic_match: { scope_filter: null, dimension_filter: null, domain_tag_filter: null },
            precomputed_rank: { max_candidates: 50, min_activation_score: 0.01 },
            semantic_supplement: { enabled: true, max_supplement: 20, embedding_enabled: false }
          },
          fine_assessment: {
            budgets: { max_entries: maxEntries, max_total_tokens: 40000, per_dimension_limits: null },
            conflict_awareness: false
          }
        }
      );
      return service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat",
        policyOverride: policy
      });
    };

const buildCompositionSynthesis = (id: string): SynthesisCapsule => ({
      object_id: id,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: `recall/${id}`,
      synthesis_type: "cross_evidence",
      summary: `Cross-evidence synthesis ${id}.`,
      evidence_refs: ["evidence-1"],
      source_memory_refs: [],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    });

it("tail-places a structural-plane gold ranked below the flat delivery cut", async () => {
      const fixture = buildStructuralFixture({ decoyCount: 6, goldPathStrength: 0.05 });
      const service = buildStructuralService(fixture);

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;

      const goldDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === "memory-gold"
      );
      // The gold is topology-DOMINATED (path_expansion) and carries a tiny lexical
      // co-admission (0.04) that satisfies the gold-blind relevance guard without
      // lifting it out of structural dominance. It still lands below the
      // entry-count cut on fused rank.
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.admission_planes).toContain("lexical");
      const goldContributions = goldDiagnostic?.fused_rank_contribution_per_stream;
      expect((goldContributions?.path_expansion ?? 0) + (goldContributions?.graph_expansion ?? 0))
        .toBeGreaterThan(
          (goldContributions?.lexical_fts ?? 0) +
            (goldContributions?.trigram_fts ?? 0) +
            (goldContributions?.evidence_fts ?? 0)
        );
      expect(goldDiagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);

      // The reserve tail-places the buried structural gold into delivery.
      expect(delivered.map((candidate) => candidate.object_id)).toContain("memory-gold");
      // Head slot is a pure multi-stream fusion winner, not a reserved tail row.
      const headDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === delivered[0]?.object_id
      );
      expect(headDiagnostic?.admission_planes).toContain("lexical");
      // A weakest in-budget non-structural row yielded its slot to the reserve.
      expect(delivered.map((candidate) => candidate.object_id)).not.toContain("memory-anchor");
    });

it("is a no-op when the structural candidate already sits inside the delivery window", async () => {
      // A lone structural candidate is rank-1 on its weight-3 stream, so it wins
      // a natural in-window slot; the reserve must not perturb that ordering.
      const fixture = buildStructuralFixture({ decoyCount: 2, goldPathStrength: 1 });
      const findByAnchorsSingle: RecallServicePathExpansionPort["findByAnchors"] = vi.fn(
        async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
          const ids = new Set(
            anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
          );
          return ids.has("memory-anchor")
            ? [
                createPathRelation({
                  path_id: "path-gold",
                  sourceId: "memory-anchor",
                  targetId: "memory-gold",
                  relationKind: "supports"
                })
              ]
            : [];
        }
      );
      const service = buildStructuralService({ ...fixture, findByAnchors: findByAnchorsSingle });

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates.map((candidate) => candidate.object_id);
      const goldDiagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === "memory-gold"
      );

      expect(delivered).toContain("memory-gold");
      // Already in-window: its delivery rank equals its natural fused rank, so
      // no tail displacement occurred.
      expect(goldDiagnostic?.final_rank).toBe(goldDiagnostic?.pre_budget_rank);
      expect(goldDiagnostic?.pre_budget_rank ?? 99).toBeLessThanOrEqual(5);
    });

it("keeps structural reserve within maxEntries when source-less synthesis rows match", async () => {
      const fixture = buildStructuralFixture({ decoyCount: 6, goldPathStrength: 0.05 });
      const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildCompositionSynthesis);
      const service = buildStructuralService({ ...fixture, synthesisRows });

      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;
      const kinds = delivered.map((candidate) => candidate.object_kind);
      const diagnosticsById = new Map(
        (result.diagnostics?.candidates ?? []).map((candidate) => [candidate.object_id, candidate])
      );
      const synthesisDelivered = delivered.filter(
        (candidate) => candidate.object_kind === "synthesis_capsule"
      );
      const structuralDelivered = delivered.filter((candidate) => {
        const diagnostic = diagnosticsById.get(candidate.object_id);
        return (
          candidate.object_kind === "memory_entry" &&
          (diagnostic?.admission_planes.includes("path_expansion") ?? false)
        );
      });

      // No overflow: delivery never exceeds the entry-count budget.
      expect(delivered.length).toBeLessThanOrEqual(5);
      // Source-less synthesis capsules are router-only and are not direct
      // delivery candidates.
      expect(synthesisDelivered.length).toBe(0);
      expect(structuralDelivered.length).toBeGreaterThan(0);
      // The structural reserve leaves >= 1 pure-fusion head slot: the head row
      // is a natural in-window lexical winner, not a tail-placed structural row.
      const head = delivered[0];
      expect(head?.object_kind).toBe("memory_entry");
      const headDiagnostic = head ? diagnosticsById.get(head.object_id) : undefined;
      expect(headDiagnostic?.admission_planes).toContain("lexical");
      expect(headDiagnostic?.pre_budget_rank).toBe(1);
      expect(kinds.every((kind) => kind === "memory_entry")).toBe(true);
    });

it("does not deliver source-less synthesis rows when no structural candidate is buried", async () => {
      // Source-less synthesis capsules match synthesis FTS, but synthesis
      // routes through source child memories instead of direct capsule delivery.
      const memories = Array.from({ length: 8 }, (_unused, index) =>
        createMemoryEntry({
          object_id: `memory-${index + 1}`,
          scope_class: ScopeClass.PROJECT,
          dimension: MemoryDimension.PROCEDURE,
          content: "Cross-evidence synthesis recall implementation exact memory.",
          activation_score: 1
        })
      );
      const { dependencies } = createDependencies(memories);
      const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildCompositionSynthesis);
      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeyword: vi.fn(async () =>
            memories.map((memory, index) => ({
              object_id: memory.object_id,
              normalized_rank: 1 - index * 0.05
            }))
          )
        },
        synthesisSearchPort: {
          searchByKeyword: vi.fn(async () => [
            { object_id: "synthesis-1", normalized_rank: 1 },
            { object_id: "synthesis-2", normalized_rank: 0.8 },
            { object_id: "synthesis-3", normalized_rank: 0.2 }
          ]),
          findByIds: vi.fn(async () => synthesisRows)
        }
      });
      const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
        fine_assessment: {
          budgets: { max_entries: 5, max_total_tokens: 4000, per_dimension_limits: null },
          conflict_awareness: false
        }
      });

      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "Cross-evidence synthesis recall implementation"
        },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });

      const delivered = result.candidates;
      expect(delivered.length).toBe(5);
      expect(
        delivered
          .filter((candidate) => candidate.object_kind === "synthesis_capsule")
          .map((candidate) => candidate.object_id)
      ).toEqual([]);
      expect(delivered.every((candidate) => candidate.object_kind === "memory_entry")).toBe(true);
    });
});
});
