import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, type PathAnchorRef } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from "../../recall/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
describe("structural delivery reserve", () => {
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
      // Lexical-only fillers: no path edge, so graph/path contribution is 0 and
      // they are never structural-rescue candidates regardless of lexical rank.
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

it("does not rescue a buried structural gold when maxEntries clamps the reserve to zero", async () => {
      // At maxEntries=1 the reserve budget is maxEntries - 1 - reservedTail = 0,
      // so the single pure-fusion head slot must survive untouched and the
      // buried structural gold stays cut.
      const { service } = buildMultiGoldFixture({
        decoyCount: 6,
        golds: [{ id: "memory-gold", pathStrength: 0.05 }]
      });
      const result = await runStructuralRecall(service, 1);
      const delivered = result.candidates;
      expect(delivered.length).toBe(1);
      expect(delivered.map((candidate) => candidate.object_id)).not.toContain("memory-gold");
      // The surviving slot is the natural pure-fusion head (rank 1), not a
      // tail-placed reserve row.
      const headDiagnostic = goldDiag(result, delivered[0]!.object_id);
      expect(headDiagnostic?.pre_budget_rank).toBe(1);
    });

it("respects the maxEntries=2 and 3 reserve boundary: no overflow, a pure-fusion head survives, reserve count clamps to the budget", async () => {
      const STRUCTURAL_DELIVERY_RESERVE = 2;
      for (const maxEntries of [2, 3]) {
        const { service } = buildMultiGoldFixture({
          decoyCount: 6,
          golds: [{ id: "memory-gold", pathStrength: 0.05 }]
        });
        const result = await runStructuralRecall(service, maxEntries);
        const delivered = result.candidates;
        const deliveredIds = delivered.map((candidate) => candidate.object_id);
        const diagnostics = result.diagnostics?.candidates ?? [];

        // No overflow of the entry-count budget.
        expect(delivered.length).toBeLessThanOrEqual(maxEntries);
        // >= 1 pure-fusion head slot survives (the natural rank-1 fusion winner).
        const headIds = new Set(deliveredIds);
        expect([...headIds].some((id) => goldDiag(result, id)?.pre_budget_rank === 1)).toBe(true);

        // The reserve places exactly min(STRUCTURAL_DELIVERY_RESERVE, buried,
        // maxEntries - 1) buried structural candidates, ranked by contribution,
        // and never displaces the rank-1 head.
        const buriedStructural = diagnostics
          .filter(
            (candidate) =>
              (candidate.pre_budget_rank ?? 0) > maxEntries && isStructuralDominant(candidate)
          )
          .sort((left, right) => structuralContribution(right) - structuralContribution(left));
        const expectedReserveCount = Math.min(
          STRUCTURAL_DELIVERY_RESERVE,
          buriedStructural.length,
          maxEntries - 1
        );
        const rescuedFromBuried = buriedStructural
          .slice(0, expectedReserveCount)
          .map((candidate) => candidate.object_id);
        for (const id of rescuedFromBuried) {
          expect(deliveredIds).toContain(id);
        }
        // The rank-1 head is never evicted by the reserve.
        const headId = diagnostics.find((candidate) => candidate.pre_budget_rank === 1)?.object_id;
        expect(headId).toBeDefined();
        expect(deliveredIds).toContain(headId!);
      }
    });

it("rescues only the top STRUCTURAL_DELIVERY_RESERVE buried structural candidates ranked by structural contribution", async () => {
      // Three golds with descending path strength -> descending structural fusion
      // contribution. With more buried structural candidates than the reserve
      // budget, only the top STRUCTURAL_DELIVERY_RESERVE (2) by that signal earn
      // a slot; the rest stay cut. The expected rescued set is computed from the
      // diagnostics using the SAME structural-dominance + structural-contribution
      // ranking the production gate uses, so this pins the ranking signal as the
      // query-relevance-weighted structural fusion contribution rather than raw
      // connectivity or arbitrary order. The weakest buried structural candidate
      // is the "distractor" that loses its slot to the more query-relevant golds.
      const STRUCTURAL_DELIVERY_RESERVE = 2;
      // Each gold carries a tiny lexical co-admission (0.04) so it passes the
      // gold-blind query/evidence-relevance guard while staying topology-
      // dominated (its weak 0.04 lexical_fts term sits below its path
      // contribution). The decoys hold STRONG lexical hits (0.89-0.99) so the
      // golds rank last in the lexical_fts stream and stay buried below the flat
      // cut. A relevance-bearing structural gold is the genuine fan-in the
      // reserve rescues; a zero-relevance membership-only sibling is refused.
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

      // All three golds are buried below the flat cut (single-stream structural).
      for (const id of ["gold-strong", "gold-mid", "gold-weak-distractor"]) {
        expect(goldDiag(result, id)?.pre_budget_rank ?? 0).toBeGreaterThan(5);
      }

      // Buried structural-dominant candidates = those whose pre-budget rank is
      // beyond the window AND structural streams dominate the fused score.
      const buriedStructural = diagnostics
        .filter(
          (candidate) =>
            (candidate.pre_budget_rank ?? 0) > 5 && isStructuralDominant(candidate)
        )
        .sort((left, right) => structuralContribution(right) - structuralContribution(left));
      // More buried structural candidates than the reserve can hold.
      expect(buriedStructural.length).toBeGreaterThan(STRUCTURAL_DELIVERY_RESERVE);

      const expectedRescued = buriedStructural
        .slice(0, STRUCTURAL_DELIVERY_RESERVE)
        .map((candidate) => candidate.object_id);
      const expectedCut = buriedStructural
        .slice(STRUCTURAL_DELIVERY_RESERVE)
        .map((candidate) => candidate.object_id);

      // The top-2 by structural contribution are delivered; the rest stay cut.
      for (const id of expectedRescued) {
        expect(delivered).toContain(id);
      }
      for (const id of expectedCut) {
        expect(delivered).not.toContain(id);
      }
      // The descending path strengths make the golds the clearly ranked tail:
      // gold-strong and gold-mid out-contribute gold-weak-distractor, which is
      // the lowest-relevance structural candidate and must be the one cut.
      expect(
        structuralContribution(goldDiag(result, "gold-strong"))
      ).toBeGreaterThan(structuralContribution(goldDiag(result, "gold-weak-distractor")));
      expect(delivered).not.toContain("gold-weak-distractor");
    });

it("rescues a structural gold co-admitted weakly on lexical, but not a strong-lexical filler", async () => {
      // The Important-fix regression pin. The genuine structural gold has real
      // path reach AND a tiny lexical co-admission (rank 0.04); admission-plane
      // membership and stream dominance are decoupled, so its fused score is
      // still graph/path-topology-dominated and it must be rescued. The filler
      // (filler-9 shape) has a STRONG lexical hit but NO graph/path reach, so its
      // topology contribution is zero and it competes fairly on the flat cut. The
      // old admission-plane gate dropped the weak-lexical gold (lexical plane
      // present -> excluded); the stream dominance gate rescues it while still
      // excluding the lexical-only filler.
      // Decoys carry strong lexical AND a strong path (multi-stream) so they
      // out-fuse the gold and keep it below the cut; the gold has a weak path
      // plus a tiny lexical hit (0.04). A widened max_supplement admits the
      // gold's low-ranked lexical hit so it genuinely co-admits on lexical while
      // staying buried. The filler has a strong lexical hit and NO path.
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
      // Widen the lexical supplement so the gold's bottom-ranked weak hit is not
      // dropped by the default max_supplement top-N cut.
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

      // The gold is co-admitted on BOTH a structural plane (path_expansion) AND
      // lexical, proving admission-plane membership and stream dominance are
      // decoupled. It is below the natural cut (the weak lexical hit does not
      // lift it past the path-buried region).
      const goldDiagnostic = goldDiag(result, "gold-weak-lexical");
      expect(goldDiagnostic?.admission_planes).toContain("path_expansion");
      expect(goldDiagnostic?.admission_planes).toContain("lexical");
      expect(goldDiagnostic?.pre_budget_rank ?? 0).toBeGreaterThan(5);
      // Its graph/path topology streams dominate its lexical-lane contribution.
      expect(isStructuralDominant(goldDiagnostic)).toBe(true);

      // The filler is lexical-dominated with zero graph/path topology reach.
      const fillerDiagnostic = goldDiag(result, "filler-strong-lexical");
      expect(fillerDiagnostic?.admission_planes).toContain("lexical");
      expect(structuralContribution(fillerDiagnostic)).toBe(0);
      expect(isStructuralDominant(fillerDiagnostic)).toBe(false);

      // Stream dominance threads the needle: the weak-lexical structural gold is
      // rescued; the strong-lexical filler is not.
      expect(delivered).toContain("gold-weak-lexical");
      expect(delivered).not.toContain("filler-strong-lexical");
    });

it("composes the strong-lexical delivery-window reorder with a buried structural rescue", async () => {
      // A strong-lexical decoy sits in the delivery window and is reordered
      // forward by prioritizeStrongLexicalDeliveryWindowCandidates; a buried
      // structural gold is rescued into the tail at the same time. Both passes
      // run without evicting each other and without overflowing the budget.
      // memory-gold carries a tiny lexical co-admission (0.04) so it passes the
      // gold-blind relevance guard while staying topology-dominated; every decoy
      // holds a strong lexical hit so the gold ranks last in the lexical_fts
      // stream and stays buried, while decoy-1 (rank 1) is reordered forward into
      // the head window.
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
      // The structural gold is rescued into the window.
      expect(deliveredIds).toContain("memory-gold");
      // A strong-lexical decoy holds a head slot ahead of the tail-placed gold.
      const goldPosition = deliveredIds.indexOf("memory-gold");
      const strongLexicalPosition = deliveredIds.findIndex((id) => {
        const diagnostic = goldDiag(result, id);
        return (diagnostic?.admission_planes.includes("lexical") ?? false) && id !== "memory-gold";
      });
      expect(strongLexicalPosition).toBeGreaterThanOrEqual(0);
      expect(strongLexicalPosition).toBeLessThan(goldPosition);
      // The structural gold is a true tail row, not displacing the head slot.
      expect(goldDiag(result, delivered[0]!.object_id)?.pre_budget_rank).toBe(1);
    });
});
});
