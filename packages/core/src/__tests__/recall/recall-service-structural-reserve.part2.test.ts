import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, type PathAnchorRef } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from "../../recall/runtime/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
describe("fusion-only structural delivery", () => {
const runStructuralRecall = (service: RecallService, maxEntries: number) => {
      const policy = overridePolicy(
        service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
        {
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

// Flexible builder mirroring buildStructuralFixture: lexical multi-stream
    // decoys each holding a strong anchor->decoy path (so the golds rank LOW on
    // the shared path_expansion stream and land below the flat cut), plus N
    // golds with independent weak path strengths. Optional per-candidate extra
    // lexical rows let a structural gold carry a WEAK lexical co-admission, or a
    // filler carry a STRONG lexical hit on top of its path co-admission.
    const buildMultiGoldFixture = (params: {
      readonly decoyCount: number;
      // object_id -> path recall_bias/strength on the anchor->gold edge.
      readonly golds: ReadonlyArray<{ readonly id: string; readonly pathStrength: number }>;
      // Lexical-only candidates with NO path edge (graph/path contribution 0).
      readonly fillerIds?: readonly string[];
      // Extra lexical rows keyed by object_id (rank in [0,1]).
      readonly extraLexicalRanks?: Readonly<Record<string, number>>;
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
      const golds = params.golds.map((gold) =>
        createMemoryEntry({
          object_id: gold.id,
          content: "Quiet downstream consumer with no query overlap zzz.",
          dimension: MemoryDimension.FACT,
          domain_tags: ["unrelated-domain"],
          activation_score: 0.05
        })
      );
      const fillers = (params.fillerIds ?? []).map((id) =>
        createMemoryEntry({
          object_id: id,
          content: "MaterializationRouter strong lexical filler match.",
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo"]
        })
      );
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
            ...params.golds.map((gold) =>
              createPathRelation({
                path_id: `path-${gold.id}`,
                sourceId: "memory-anchor",
                targetId: gold.id,
                relationKind: "supports",
                recallBias: gold.pathStrength,
                strength: gold.pathStrength,
                stabilityClass: "normal"
              })
            )
          ];
        }
      );
      const memories = [anchor, ...decoys, ...golds, ...fillers];
      const { dependencies } = createDependencies(memories);
      // Anchor is the entity-seed lexical hit. Per-candidate extra lexical ranks
      // layer on top via searchByKeywordWithinObjectIds so a structural gold can
      // carry a WEAK 0.04 hit or a filler a STRONG 0.95 hit. Candidates absent
      // from this map admit only on their path/structural plane.
      const lexicalRanks: Record<string, number> = {
        "memory-anchor": 0.9,
        ...(params.extraLexicalRanks ?? {})
      };
      const service = new RecallService({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          searchByKeywordWithinObjectIds: vi.fn(
            async (_workspaceId: string, query: string, limit: number, candidateIds?: readonly string[]) =>
              query.toLowerCase().includes("materializationrouter")
                ? Object.entries(lexicalRanks)
                    .filter(
                      ([object_id]) => candidateIds === undefined || candidateIds.includes(object_id)
                    )
                    .map(([object_id, normalized_rank]) => ({ object_id, normalized_rank }))
                    .sort((left, right) => right.normalized_rank - left.normalized_rank)
                    .slice(0, limit)
                : []
          )
        },
        pathExpansionPort: { findByAnchors },
        entityExtractionPort: {
          extract: async () => [
            Object.freeze({
              surface: "MaterializationRouter",
              normalized: "materializationrouter",
              kind: "quoted" as const,
              confidence: 1.0
            })
          ]
        }
      });
      return { service, golds: golds.map((gold) => gold.object_id) };
    };

const goldDiag = (
      result: Awaited<ReturnType<RecallService["recall"]>>,
      id: string
    ) => result.diagnostics?.candidates.find((candidate) => candidate.object_id === id);

// Mirror the production gate from the candidate diagnostics so tests pin the
    // exact contract rather than a hand-guessed admission shape. structural =
    // graph/path topology lanes; lexical = the lexical/evidence-FTS/agreement
    // lanes; structural(generic)/existing_score/recency/activation are neutral
    // (excluded from both).
    // see also: recall-service.ts STRUCTURAL_FUSION_STREAMS / LEXICAL_LANE_FUSION_STREAMS.
    const structuralContribution = (
      diagnostic: ReturnType<typeof goldDiag>
    ): number => {
      const contributions = diagnostic?.fused_rank_contribution_per_stream;
      if (contributions === undefined) {
        return 0;
      }
      return contributions.graph_expansion + contributions.path_expansion;
    };

const lexicalLaneContribution = (
      diagnostic: ReturnType<typeof goldDiag>
    ): number => {
      const contributions = diagnostic?.fused_rank_contribution_per_stream;
      if (contributions === undefined) {
        return 0;
      }
      return (
        contributions.lexical_fts +
        contributions.trigram_fts +
        contributions.synthesis_fts +
        contributions.evidence_fts +
        contributions.evidence_structural_agreement +
        contributions.source_proximity +
        contributions.source_evidence_agreement +
        contributions.subject_alignment +
        contributions.embedding_similarity +
        contributions.entity_seed
      );
    };

const isStructuralDominant = (diagnostic: ReturnType<typeof goldDiag>): boolean => {
      const structural = structuralContribution(diagnostic);
      return structural > 0 && structural > lexicalLaneContribution(diagnostic);
    };

it("keeps the fusion head and cuts buried path evidence at maxEntries=1", async () => {
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "memory-gold", pathStrength: 0.05 }]
      });
      const result = await runStructuralRecall(service, 1);
      const delivered = result.candidates;
      expect(delivered.length).toBe(1);
      expect(delivered.map((candidate) => candidate.object_id)).not.toContain("memory-gold");
      const headDiagnostic = goldDiag(result, delivered[0]!.object_id);
      expect(headDiagnostic?.pre_budget_rank).toBe(1);
      expect(headDiagnostic?.final_rank).toBe(1);
      const goldDiagnostic = goldDiag(result, "memory-gold");
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(structuralContribution(goldDiagnostic)).toBeGreaterThan(0);
      expect(goldDiagnostic?.final_rank).toBeNull();
      expect(goldDiagnostic?.rank_after_structural_reserve).toBe(goldDiagnostic?.fused_rank);
      expect(goldDiagnostic?.reserved_by).toBe("none");
    });

it("respects maxEntries=2 and 3 without post-fusion displacement", async () => {
      for (const maxEntries of [2, 3]) {
        const { service } = buildMultiGoldFixture({
          decoyCount: 6,
          golds: [{ id: "memory-gold", pathStrength: 0.05 }]
        });
        const result = await runStructuralRecall(service, maxEntries);
        const delivered = result.candidates;
        const deliveredIds = delivered.map((candidate) => candidate.object_id);
        const diagnostics = result.diagnostics?.candidates ?? [];

        expect(delivered.length).toBeLessThanOrEqual(maxEntries);
        for (const candidate of diagnostics) {
          expect(candidate.rank_after_feature_rerank).toBe(candidate.fused_rank);
          expect(candidate.rank_after_lexical_priority).toBe(candidate.fused_rank);
          expect(candidate.rank_after_structural_reserve).toBe(candidate.fused_rank);
          expect(candidate.reserved_by).toBe("none");
          if (candidate.fused_rank <= maxEntries) {
            expect(deliveredIds).toContain(candidate.object_id);
            expect(candidate.final_rank).toBe(candidate.fused_rank);
          } else {
            expect(deliveredIds).not.toContain(candidate.object_id);
            expect(candidate.final_rank).toBeNull();
          }
        }
        const headId = diagnostics.find((candidate) => candidate.pre_budget_rank === 1)?.object_id;
        expect(headId).toBeDefined();
        expect(deliveredIds).toContain(headId!);
      }
    });

it("keeps structural contribution visible without granting tail slots", async () => {
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [
          { id: "gold-strong", pathStrength: 0.5 },
          { id: "gold-mid", pathStrength: 0.3 },
          { id: "gold-weak-distractor", pathStrength: 0.05 }
        ],
        extraLexicalRanks: {
          "decoy-1": 0.99,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "gold-strong": 0.04,
          "gold-mid": 0.04,
          "gold-weak-distractor": 0.04
        }
      });
      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates.map((candidate) => candidate.object_id);
      const diagnostics = result.diagnostics?.candidates ?? [];

      for (const id of ["gold-strong", "gold-mid", "gold-weak-distractor"]) {
        const diagnostic = goldDiag(result, id);
        expect(diagnostic?.admission_planes).toContain("path_expansion");
        expect(structuralContribution(diagnostic)).toBeGreaterThan(0);
        expect(diagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);
        expect(diagnostic?.final_rank).toBeNull();
        expect(diagnostic?.rank_after_structural_reserve).toBe(diagnostic?.fused_rank);
        expect(diagnostic?.reserved_by).toBe("none");
        expect(delivered).not.toContain(id);
      }
      expect(delivered.length).toBeLessThanOrEqual(5);
      expect(diagnostics.filter((candidate) => candidate.within_budget).length).toBe(delivered.length);
      expect(
        structuralContribution(goldDiag(result, "gold-strong"))
      ).toBeGreaterThan(structuralContribution(goldDiag(result, "gold-weak-distractor")));
    });

it("distinguishes path-plus-lexical evidence from lexical-only evidence", async () => {
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "gold-weak-lexical", pathStrength: 0.05 }],
        fillerIds: ["filler-strong-lexical"],
        extraLexicalRanks: {
          "decoy-1": 0.99,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "gold-weak-lexical": 0.04,
          "filler-strong-lexical": 0.95
        }
      });
      const policy = overridePolicy(
        service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
        {
          coarse_filter: {
            deterministic_match: { scope_filter: null, dimension_filter: null, domain_tag_filter: null },
            precomputed_rank: { max_candidates: 50, min_activation_score: 0.01 },
            semantic_supplement: { enabled: true, max_supplement: 20, embedding_enabled: false }
          },
          fine_assessment: {
            budgets: { max_entries: 5, max_total_tokens: 40000, per_dimension_limits: null },
            conflict_awareness: false
          }
        }
      );
      const result = await service.recall({
        taskSurface: {
          ...createTaskSurface(),
          display_name: "How does MaterializationRouter coordinate writes?"
        },
        workspaceId: "workspace-1",
        strategy: "chat",
        policyOverride: policy
      });
      const delivered = result.candidates.map((candidate) => candidate.object_id);

      const goldDiagnostic = goldDiag(result, "gold-weak-lexical");
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.admission_planes).toContain("lexical");
      expect(goldDiagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);
      expect(isStructuralDominant(goldDiagnostic)).toBe(true);

      const fillerDiagnostic = goldDiag(result, "filler-strong-lexical");
      expect(fillerDiagnostic?.admission_planes).toContain("lexical");
      expect(structuralContribution(fillerDiagnostic)).toBe(0);
      expect(isStructuralDominant(fillerDiagnostic)).toBe(false);

      expect(goldDiagnostic?.rank_after_structural_reserve).toBe(goldDiagnostic?.fused_rank);
      expect(goldDiagnostic?.final_rank).toBeNull();
      expect(delivered).not.toContain("gold-weak-lexical");
      expect(delivered).not.toContain("filler-strong-lexical");
    });

it("keeps lexical and structural legacy stages aligned to fusion", async () => {
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "memory-gold", pathStrength: 0.05 }],
        extraLexicalRanks: {
          "decoy-1": 1,
          "decoy-2": 0.97,
          "decoy-3": 0.95,
          "decoy-4": 0.93,
          "decoy-5": 0.91,
          "decoy-6": 0.89,
          "memory-gold": 0.04
        }
      });
      const result = await runStructuralRecall(service, 5);
      const delivered = result.candidates;
      const deliveredIds = delivered.map((candidate) => candidate.object_id);

      expect(delivered.length).toBeLessThanOrEqual(5);
      expect(deliveredIds).not.toContain("memory-gold");
      const goldDiagnostic = goldDiag(result, "memory-gold");
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.rank_after_lexical_priority).toBe(goldDiagnostic?.fused_rank);
      expect(goldDiagnostic?.rank_after_structural_reserve).toBe(goldDiagnostic?.fused_rank);
      expect(goldDiagnostic?.final_rank).toBeNull();
      expect(goldDiag(result, delivered[0]!.object_id)?.pre_budget_rank).toBe(1);
      expect(
        delivered.map((candidate) => goldDiag(result, candidate.object_id)?.fused_rank)
      ).toEqual([1, 2, 3, 4, 5]);
    });
});
});
