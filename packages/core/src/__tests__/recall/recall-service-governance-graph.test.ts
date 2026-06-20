import { describe, expect, it, vi } from "vitest";
import { type PathAnchorRef, type PathRelation, type RecallCandidate } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from "../../recall/recall-service-types.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
describe("governance manifestation HARD CEILING — truth boundary", () => {
    // invariant: the manifestation ceiling derives from a memory's INBOUND
    // recall-eligible PathRelations' governance band, but it must NOT trust an
    // agent-pumpable recall_allowed (one reached via the support_events_count
    // auto-promotion ladder) and must NOT vanish on a transient path-store read
    // error. see also: recall-service.ts collectGovernanceCeilings,
    //   path-manifestation-policy.ts memoryGovernanceCeiling.
    const VICTIM_LONG_CONTENT =
      "deployment rollback procedure detail one with enough body text to exceed the " +
      "one-hundred-and-sixty character preview clip so a capped band visibly truncates " +
      "the delivered preview while a full_eligible band serves the entire content body.";

    const runCeilingRecall = async (params: {
      readonly findByAnchors: RecallServicePathExpansionPort["findByAnchors"];
    }): Promise<Readonly<RecallCandidate> | undefined> => {
      const memories = [
        createMemoryEntry({
          object_id: "seed-memory",
          content: "deployment rollback procedure overview",
          activation_score: 0.9
        }),
        createMemoryEntry({
          object_id: "victim-target",
          content: VICTIM_LONG_CONTENT,
          // 0.95 lands in the full_eligible strength tier, so the delivered
          // manifestation equals the governance ceiling (clamp is a pure min).
          activation_score: 0.95
        })
      ];
      const { dependencies } = createDependencies(memories);
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors: params.findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail one" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      return result.candidates.find((candidate) => candidate.object_id === "victim-target");
    };

    // Returns an inbound recall-eligible path target=victim-target only when the
    // victim id is among the ceiling-lookup anchors (the ceiling read passes
    // every admitted candidate id and keeps paths whose target is a candidate).
    const inboundPathFinder = (
      path: PathRelation
    ): RecallServicePathExpansionPort["findByAnchors"] =>
      vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return ids.has("victim-target") ? [path] : [];
      });

    it("Finding #2: an auto-promoted recall_allowed (pumped support, birth marker only) caps the victim at excerpt", async () => {
      // The inbound positive path climbed attention_only -> recall_allowed by
      // pumping support_events_count via agent report_context_usage receipts;
      // evidence_basis still carries only its co-usage birth marker. The ceiling
      // must treat it as attention_only (excerpt), NOT full_eligible, so preview
      // content is not over-surfaced.
      const pumpedPath = createPathRelation({
        path_id: "path-pos-pumped-recall-allowed",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "co_recalled",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(pumpedPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("excerpt");
      // Over-surfacing is actually prevented: the delivered preview is clipped,
      // not the full long body.
      expect(victim?.content_preview).not.toBe(VICTIM_LONG_CONTENT);
      expect(victim?.content_preview.length ?? 0).toBeLessThan(VICTIM_LONG_CONTENT.length);
    });

    it("Finding #2: a trusted-seed recall_allowed (signal_graph_reference) lifts the victim to full_eligible", async () => {
      // A recall_allowed BORN at that band by the system signal-graph seed is
      // trusted provenance; the legitimate path still serves full content.
      const trustedPath = createPathRelation({
        path_id: "path-pos-trusted-signal-graph",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "signal_graph_ref",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["signal_graph_reference"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(trustedPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
      expect(victim?.content_preview).toBe(VICTIM_LONG_CONTENT);
    });

    it("Finding #2: a human/auto edge-accept recall_allowed (edge_proposal_accept:<id>) lifts the victim to full_eligible", async () => {
      const acceptPath = createPathRelation({
        path_id: "path-pos-edge-accept",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "supports",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "recall_allowed",
        evidenceBasis: ["edge_proposal_accept:edge_prop_xyz789"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(acceptPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
    });

    it("Finding #2: strictly_governed (user-set, not auto-reachable) lifts the victim to full_eligible regardless of evidence", async () => {
      const strictPath = createPathRelation({
        path_id: "path-pos-strict",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "supports",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "strictly_governed",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      const victim = await runCeilingRecall({ findByAnchors: inboundPathFinder(strictPath) });
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
    });

    it("Finding #3: a thrown findByAnchors fails CLOSED — every candidate is capped to the LOWEST visibility band (hint), never over-surfaced", async () => {
      // A transient path-store read error must NOT lift a governed memory to its
      // full strength tier. The ceiling map is NOT empty-meaning-unrestricted on
      // throw: every candidate is capped to GOVERNANCE_CEILING_FAILSAFE_BAND
      // (hint). hint is the only band that is never an over-surface for ANY
      // governance class — a memory whose TRUE ceiling is hint (hint_only) is NOT
      // over-surfaced to excerpt on a read blip. At the lens hint renders a bare
      // `[memory ref: <id>]` (zero body); see the context-lens-assembler proof
      // test below. see also: recall-service.ts collectGovernanceCeilings (throw),
      //   path-manifestation-policy.ts GOVERNANCE_CEILING_FAILSAFE_BAND.
      const throwingFinder = vi.fn(async () => {
        throw new Error("transient path-store read failure");
      });
      const victim = await runCeilingRecall({ findByAnchors: throwingFinder });
      expect(victim).toBeDefined();
      // full_eligible strength tier capped to the fail-closed safe band (hint).
      expect(victim?.manifestation).toBe("hint");
      expect(victim?.content_preview).not.toBe(VICTIM_LONG_CONTENT);
      expect(victim?.content_preview.length ?? 0).toBeLessThan(VICTIM_LONG_CONTENT.length);
    });

    it("Finding #3: a hint_only true-ceiling memory is never surfaced above hint on the failure path", async () => {
      // The failsafe IS hint, so a memory whose TRUE governance ceiling is hint
      // (hint_only) cannot be over-surfaced by the throw branch: the capped band
      // equals its true ceiling exactly. This holds by construction — assert it so
      // raising GOVERNANCE_CEILING_FAILSAFE_BAND above hint (the latent over-surface)
      // re-fails here. see also: path-manifestation-policy.ts GOVERNANCE_MANIFESTATION_CEILING
      //   (hint_only -> hint), GOVERNANCE_CEILING_FAILSAFE_BAND.
      const hintOnlyPath = createPathRelation({
        path_id: "path-pos-hint-only",
        sourceId: "seed-memory",
        targetId: "victim-target",
        relationKind: "co_recalled",
        recallBias: 0.5,
        strength: 0.95,
        stabilityClass: "stable",
        governanceClass: "hint_only",
        evidenceBasis: ["recalls_edge_co_usage"]
      });
      // Throw on the governance read: the victim's true ceiling (hint_only -> hint)
      // and the failsafe band (hint) coincide, so it is at most hint either way.
      const throwingFinder = vi.fn(async () => {
        throw new Error("transient path-store read failure");
      });
      const onThrow = await runCeilingRecall({ findByAnchors: throwingFinder });
      expect(onThrow).toBeDefined();
      expect(onThrow?.manifestation).toBe("hint");
      // And when the read succeeds with the hint_only path, the ceiling is hint too:
      // the failsafe never surfaces a hint_only memory above its real ceiling.
      const onRead = await runCeilingRecall({ findByAnchors: inboundPathFinder(hintOnlyPath) });
      expect(onRead).toBeDefined();
      expect(onRead?.manifestation).toBe("hint");
    });

    it("Finding #3: an ABSENT pathExpansionPort stays OPEN — the victim reaches its full strength tier", async () => {
      // No governance plane deployed: the empty ceiling map legitimately means
      // unrestricted (full_eligible), distinct from the thrown-lookup case.
      const memories = [
        createMemoryEntry({
          object_id: "victim-target",
          content: VICTIM_LONG_CONTENT,
          activation_score: 0.95
        })
      ];
      const { dependencies } = createDependencies(memories);
      const service = new RecallService({ ...dependencies });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail one" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.candidates.find((candidate) => candidate.object_id === "victim-target");
      expect(victim).toBeDefined();
      expect(victim?.manifestation).toBe("full_eligible");
      expect(victim?.content_preview).toBe(VICTIM_LONG_CONTENT);
    });
  });

it("expands path-graph candidates across two hops with cycle-safe edge-type decay diagnostics", async () => {
    // The hop-2 traversal score MAGNITUDES (0.25 / 0.045) equal the static
    // EDGE_TYPE_RECALL_MODEL.contribution_weight basis because
    // graphTraversalScoreFromPath returns that basis and the hop_decay constants
    // are unchanged; traversal TOPOLOGY follows path direction_bias, not the
    // undirected edge plane (paths here are bidirectional_asymmetric so reach is
    // full). The merge moves the hop-1 direct association (seed -> hop1-derived)
    // onto the path_expansion plane, so it no longer counts in graph_expansion's
    // per_hop[0] / per_edge_type — the graph plane carries only the multi-hop
    // reach now.
    // see also: packages/core/src/recall/graph-expansion.ts:graphTraversalScoreFromPath.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "hop1-derived",
        content: "First hop derived graph neighbor.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-supported",
        content: "Second hop supported graph answer.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "hop2-recalled",
        content: "Second hop recalled graph answer.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      }),
      createMemoryEntry({
        object_id: "superseded-target",
        content: "Superseded graph target should not propagate.",
        activation_score: 0.1,
        domain_tags: ["graph-hop"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    const seedToHop1 = createPathRelation({
      path_id: "path-derives",
      sourceId: "seed-memory",
      targetId: "hop1-derived",
      relationKind: "derives_from",
      strength: 1
    });
    // Negative-bias path off the seed: recall_bias < 0 makes it ineligible, so
    // the traversal must never follow it (mirrors the floored supersedes edge).
    const seedToSuperseded = createPathRelation({
      path_id: "path-supersedes",
      sourceId: "seed-memory",
      targetId: "superseded-target",
      relationKind: "supersedes",
      recallBias: -0.5,
      strength: 0.9
    });
    const hop1ToCycle = createPathRelation({
      path_id: "path-cycle",
      sourceId: "hop1-derived",
      targetId: "seed-memory",
      relationKind: "supports",
      strength: 1
    });
    const hop1ToSupported = createPathRelation({
      path_id: "path-supports",
      sourceId: "hop1-derived",
      targetId: "hop2-supported",
      relationKind: "supports",
      strength: 1
    });
    const hop1ToRecalled = createPathRelation({
      path_id: "path-recalls",
      sourceId: "hop1-derived",
      targetId: "hop2-recalled",
      relationKind: "recalls",
      strength: 1
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      const out: PathRelation[] = [];
      if (ids.has("seed-memory")) {
        out.push(seedToHop1, seedToSuperseded);
      }
      if (ids.has("hop1-derived")) {
        out.push(hop1ToCycle, hop1ToSupported, hop1ToRecalled);
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

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      expect.arrayContaining(["seed-memory", "hop1-derived", "hop2-supported", "hop2-recalled"])
    );
    // hop1-derived is a direct association -> path_expansion plane.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop1-derived")?.admission_planes
    ).toContain("path_expansion");
    // Negative-bias path is never followed, so its target stays out of both
    // associative planes.
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "superseded-target")
        ?.admission_planes ?? []
    ).not.toContain("graph_expansion");
    // graph_expansion carries only the two hop-2 neighbors now.
    expect(result.diagnostics?.graph_expansion_plane_count_per_hop).toEqual([0, 2]);
    expect(result.diagnostics?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 1,
      supports: 1
    });
    // score magnitude equals the static contribution_weight basis (0.25).
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-supported")?.structural_score
    ).toBeCloseTo(0.25);
    expect(
      result.diagnostics?.candidates.find((candidate) => candidate.object_id === "hop2-recalled")?.structural_score
    ).toBeCloseTo(0.045);
    // The negative path's target is never used as a BFS anchor.
    const anchoredIds = findByAnchors.mock.calls.flatMap((call) =>
      call[1].flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
    );
    expect(anchoredIds).not.toContain("superseded-target");
  });
});
