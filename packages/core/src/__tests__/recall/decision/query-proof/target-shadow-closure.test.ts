import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issuePsiV2AuthorityArtifact,
  type PsiV2AuthorityArtifactV1,
  type PsiV2PairOutcomeV1
} from "../../../../recall/decision/query-proof/dominance/authority.js";
import { queryClassCapabilityStatus } from "../../../../recall/decision/query-proof/gamma/capability-matrix.js";
import { buildDeliveryPack } from "../../../../recall/decision/query-proof/delivery/pack.js";
import * as deliveryPack from "../../../../recall/decision/query-proof/delivery/pack.js";
import {
  prefixSK,
  type ShadowCapturedWalk,
  type ShadowCaptureWalkCandidate
} from "../../../../recall/decision/prefix-capture/walk.js";
import {
  CAPTURE_IDENTITY_DIGEST,
  SHADOW_CAPTURE_OPERATOR_ID,
  SHADOW_DETERMINISTIC_TAIL
} from "../../../../recall/decision/prefix-capture/identity.js";
import { emptySetUtilityInput } from "../../../../recall/decision/prefix-capture/capture.js";
import { DEFAULT_RESOURCE_FEASIBILITY_POLICY } from
  "../../../../recall/decision/query-proof/gamma/contract.js";
import {
  observeTargetDeliveryPack,
  projectTargetCandidateDispositions,
  type QueryProofCandidateDispositionKindV1,
  type QueryProofPreviewSidecar
} from "../../../../recall/integration/shadow/query-proof-preview.js";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace
} from "../../../../recall/integration/shadow/integrate.js";
import { ShadowContractError } from "../../../../recall/decision/contract-primitives.js";
import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import { compileRecallQueryProbes } from "../../../../recall/query/recall-query-probes.js";
import type { CoarseRecallCandidate } from "../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import type { PsiV2CandidateV1, PsiV2CoordinateV1 } from
  "../../../../recall/decision/query-proof/dominance/types.js";

describe("target-shadow-chain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe("source-jurisdiction", () => {
    it("classifies query class capabilities according to honest source ownership", () => {
      expect(queryClassCapabilityStatus("scalar_simple")).toMatchObject({
        capability: "scalar_simple",
        source_owner: null,
        source_available: false,
        supported_in_shadow: false,
        unsupported_reason: "scalar_simple_source_unproved"
      });
      expect(queryClassCapabilityStatus("scalar_simple", {
        owner: "osf",
        available: true
      })).toMatchObject({
        capability: "scalar_simple",
        source_owner: "osf",
        source_available: true,
        supported_in_shadow: true
      });

      expect(queryClassCapabilityStatus("required_proposition")).toMatchObject({
        capability: "required_proposition",
        source_available: false,
        supported_in_shadow: false
      });
      expect(queryClassCapabilityStatus("required_proposition", {
        owner: "support",
        available: true
      })).toMatchObject({
        capability: "required_proposition",
        source_owner: "support",
        source_available: true,
        supported_in_shadow: true
      });

      expect(queryClassCapabilityStatus("certified_independent_support")).toMatchObject({
        capability: "certified_independent_support",
        source_available: false,
        supported_in_shadow: false
      });
      expect(queryClassCapabilityStatus("certified_independent_support", {
        owner: "support",
        available: true
      })).toMatchObject({
        capability: "certified_independent_support",
        source_owner: "support",
        source_available: true,
        supported_in_shadow: true
      });

      expect(queryClassCapabilityStatus("distinct")).toMatchObject({
        capability: "distinct",
        supported_in_shadow: false,
        unsupported_reason: "distinctness_source_unsupported"
      });
      expect(queryClassCapabilityStatus("sequence")).toMatchObject({
        capability: "sequence",
        supported_in_shadow: false,
        unsupported_reason: "sequence_slots_source_unsupported"
      });
      expect(queryClassCapabilityStatus("extremum")).toMatchObject({
        capability: "extremum",
        supported_in_shadow: false,
        unsupported_reason: "extremum_witness_source_unsupported"
      });
    });
  });

  describe("issued-psi-v2-authority", () => {
    it("issues a complete, structural Psi-v2 artifact conserving complete pair domain", () => {
      const candidates: readonly PsiV2CandidateV1[] = [
        {
          candidate_id: "c-1",
          coordinates: [
            {
              proposition_id: "p-1",
              proposition_schema: "ps",
              identity: null,
              collapse: {
                status: "collapsed",
                witness: { domain: "numeric_interval", value: 10 }
              } as unknown as PsiV2CoordinateV1["collapse"],
              admission: null,
              applicable: true,
              lex_domain: null,
              envelope_identity: null
            }
          ]
        },
        {
          candidate_id: "c-2",
          coordinates: [
            {
              proposition_id: "p-1",
              proposition_schema: "ps",
              identity: null,
              collapse: {
                status: "collapsed",
                witness: { domain: "numeric_interval", value: 5 }
              } as unknown as PsiV2CoordinateV1["collapse"],
              admission: null,
              applicable: true,
              lex_domain: null,
              envelope_identity: null
            }
          ]
        },
        {
          candidate_id: "c-3",
          coordinates: []
        }
      ];

      const artifact = issuePsiV2AuthorityArtifact({
        query_digest: "sha256:query1",
        snapshot_digest: "sha256:snap1",
        workspace_id: "ws-1",
        candidates,
        current_authorities: []
      });

      expect(artifact.schema_version).toBe(1);
      expect(artifact.candidate_universe).toEqual(["c-1", "c-2", "c-3"]);
      expect(artifact.pair_outcomes).toHaveLength(6);
      expect(artifact.cycle_status).toBe("no_cycle");
      expect(artifact.first_frontier_size).toBeGreaterThanOrEqual(1);
      expect(artifact.frontier_depth).toBeGreaterThanOrEqual(1);
      expect(artifact.structural_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe("pack-mode", () => {
    it("binds the target prefix decided by Decide_Q rather than live canonical prefix", () => {
      const targetPrefix = ["target-cand-1", "target-cand-2"];
      const livePrefix = ["live-cand-A", "live-cand-B"];
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: capturedSidecar(targetPrefix, "best_effort_uncertified") },
        snapshot_digest: DIGEST,
        capture_identity_digest: "sha256:capture-ident"
      });

      expect(pack.selected_candidates).toEqual(targetPrefix);
      expect(pack.selected_candidates).not.toEqual(livePrefix);
      expect(pack.mode).toBe("best_effort_uncertified");
      expect(pack.pack_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("emits certified DeliveryPack with matching claims when execution is certified", () => {
      const targetPrefix = ["c-1"];
      const pack = buildDeliveryPack({
        mode: "certified",
        query_digest: DIGEST,
        snapshot_digest: DIGEST,
        decision_contract_digest: DIGEST,
        capture_identity_digest: "sha256:cap-ident",
        selected_candidates: targetPrefix,
        answer_kind: "scalar",
        answer_bindings: [{
          candidate_key: "c-1",
          variable: "x",
          semantic_identity: "alice",
          binding_id: "b-1"
        }],
        propositions: [],
        evidence_groups: [],
        holes: [],
        conflicts: [],
        completeness_scope: null,
        principal_scope: { delivery_interference: false }
      });

      expect(pack.mode).toBe("certified");
      expect(pack.selected_candidates).toEqual(["c-1"]);
      expect(pack.allowed_claims).toContain("scalar");
    });

    it.each([
      ["best_effort_uncertified", ["t-1"]],
      ["abstained", []],
      ["unsupported", []],
      ["conflict", ["t-1"]]
    ] as const)("projects pack_mode %s from the target sidecar", (mode, prefix) => {
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: capturedSidecar([...prefix], mode) },
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.mode).toBe(mode);
      expect(pack.selected_candidates).toEqual(prefix);
      expect(pack.selected_candidates).not.toEqual(["live-1"]);
    });

    it("does not bind a live prefix when the target sidecar is absent", () => {
      const pack = observeTargetDeliveryPack({
        preview: {},
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.mode).toBe("unsupported");
      expect(pack.selected_candidates).toEqual([]);
    });

    it("does not serialize a failed preview as live-prefix success", () => {
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: failedSidecar() },
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.mode).toBe("unsupported");
      expect(pack.selected_candidates).toEqual([]);
    });

    it("keeps one prefix for K and a monotone extension for K+1", () => {
      const sInfty = ["a", "b", "c"];
      const atK = prefixSK(sInfty, 2);
      const atKPlus = prefixSK(sInfty, 3);
      expect(atK).toEqual(["a", "b"]);
      expect(atKPlus.slice(0, atK.length)).toEqual(atK);
      const first = observeTargetDeliveryPack({
        preview: { query_proof_preview: capturedSidecar(atK, "best_effort_uncertified") },
        snapshot_digest: DIGEST,
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      const second = observeTargetDeliveryPack({
        preview: { query_proof_preview: capturedSidecar(atK, "best_effort_uncertified") },
        snapshot_digest: DIGEST,
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(first.selected_candidates).toEqual(atK);
      expect(first.pack_digest).toBe(second.pack_digest);
    });

    it("clamps certified sidecar packs to best_effort_uncertified on the shadow emission path", () => {
      const sidecar = capturedSidecar(["c-1"], "certified", {
        decision_identity_digest: DIGEST,
        first_frontier_size: 1,
        frontier_depth: 1
      });
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: sidecar },
        snapshot_digest: DIGEST,
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.mode).toBe("best_effort_uncertified");
      expect(pack.selected_candidates).toEqual(sidecar.prefix);
      expect(pack.selected_candidates).toEqual(sidecar.candidate_prefix);
      expect(pack.capture_identity_digest).toBe(DIGEST);
      expect(pack.capture_identity_digest).not.toBe(CAPTURE_IDENTITY_DIGEST);
    });

    it("omits missing Decide_Q identity instead of hashing null", () => {
      const sidecar = capturedSidecar(["t-1"], "best_effort_uncertified");
      expect(sidecar.decision_identity_digest).toBeUndefined();
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: sidecar },
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.capture_identity_digest).toBe(CAPTURE_IDENTITY_DIGEST);
      expect(pack.selected_candidates).toEqual(["t-1"]);
    });
  });

  describe("target-chain-projection", () => {
    it("classifies the field-to-prefixSK dispositions from one captured walk", () => {
      const kinds: readonly QueryProofCandidateDispositionKindV1[] = [
        "not_in_field",
        "in_field_unavailable_before_psi",
        "dominated",
        "incomparable",
        "uncertain",
        "cycle",
        "gamma_infeasible",
        "gamma_unresolved",
        "gamma_zero",
        "gamma_positive_by_stratum",
        "resource_rejected",
        "selected_within_top5",
        "selected_after_top5"
      ];
      expect(new Set(kinds).size).toBe(13);
      const dispositions = projectTargetCandidateDispositions({
        candidates: [
          plantedCandidate("in-field"),
          plantedCandidate("unavailable", false),
          plantedCandidate("dominated"),
          plantedCandidate("uncertain"),
          plantedCandidate("infeasible"),
          plantedCandidate("unresolved"),
          plantedCandidate("rejected"),
          plantedCandidate("picked-early"),
          plantedCandidate("picked-late"),
          plantedCandidate("positive"),
          plantedCandidate("incomparable")
        ],
        feasibility: Object.freeze([
          { candidate_key: "infeasible", semantic: "infeasible" as const },
          { candidate_key: "unresolved", semantic: "unresolved" as const },
          { candidate_key: "picked-early", semantic: "feasible" as const },
          { candidate_key: "picked-late", semantic: "feasible" as const },
          { candidate_key: "positive", semantic: "feasible" as const },
          { candidate_key: "incomparable", semantic: "feasible" as const }
        ]),
        psi_edges: Object.freeze([["picked-early", "dominated"]] as const),
        artifact: plantedArtifact({
          universe: [
            "in-field", "unavailable", "dominated", "uncertain", "infeasible",
            "unresolved", "rejected", "picked-early", "picked-late", "positive",
            "incomparable", "ghost"
          ],
          pairs: [
            { left: "picked-early", right: "dominated", outcome: "strict_edge" },
            { left: "dominated", right: "picked-early", outcome: "reverse_edge" },
            { left: "uncertain", right: "infeasible", outcome: "uncertain" },
            { left: "infeasible", right: "uncertain", outcome: "uncertain" },
            { left: "incomparable", right: "in-field", outcome: "incomparable" },
            { left: "in-field", right: "incomparable", outcome: "incomparable" }
          ]
        }),
        walk: plantedWalk({
          sInfty: ["picked-early", "a2", "a3", "a4", "a5", "picked-late"],
          rejects: [{ candidate_key: "rejected", walk_reject: "max_total_tokens" }],
          decisions: [plantedDecision("picked-early", ["positive"])]
        })
      });
      const byKey = Object.fromEntries(
        dispositions.map((row) => [row.candidate_key, row.disposition])
      );
      expect(byKey.ghost).toBe("not_in_field");
      expect(byKey.unavailable).toBe("in_field_unavailable_before_psi");
      expect(byKey.dominated).toBe("dominated");
      expect(byKey.uncertain).toBe("uncertain");
      expect(byKey.infeasible).toBe("gamma_infeasible");
      expect(byKey.unresolved).toBe("gamma_unresolved");
      expect(byKey.rejected).toBe("resource_rejected");
      expect(byKey["picked-early"]).toBe("selected_within_top5");
      expect(byKey["picked-late"]).toBe("selected_after_top5");
      expect(byKey.positive).toBe("gamma_positive_by_stratum");
      expect(byKey.incomparable).toBe("incomparable");
    });

    it("classifies cycle from the issued artifact without rerunning prefixSK", () => {
      const dispositions = projectTargetCandidateDispositions({
        candidates: [plantedCandidate("a"), plantedCandidate("b")],
        feasibility: Object.freeze([]),
        psi_edges: Object.freeze([]),
        artifact: plantedArtifact({
          universe: ["a", "b"],
          cycle: true,
          firstFrontier: null,
          frontierDepth: null
        }),
        walk: plantedWalk({ sInfty: [] })
      });
      expect(dispositions.map((row) => row.disposition)).toEqual(["cycle", "cycle"]);
    });

    it("copies sidecar frontiers from the issued artifact and keeps failed frontiers unavailable", () => {
      const captured = capturedSidecar(["t-1"], "best_effort_uncertified", {
        first_frontier_size: 2,
        frontier_depth: 3
      });
      expect(captured.first_frontier_size).toBe(2);
      expect(captured.frontier_depth).toBe(3);
      expect(captured.first_frontier_size).not.toBe(captured.frontier_depth);
      const failed = failedSidecar();
      expect(failed.first_frontier_size).toBeNull();
      expect(failed.frontier_depth).toBeNull();
      expect(JSON.stringify(failed)).not.toMatch(/"first_frontier_size":0/u);
      expect(JSON.stringify(failed)).not.toMatch(/"frontier_depth":0/u);
      expect("decision_identity_digest" in failed).toBe(false);
    });

    it("binds pack selected_candidates to sidecar.prefix only", () => {
      const sidecar = capturedSidecar(["target-1", "target-2"], "best_effort_uncertified");
      const pack = observeTargetDeliveryPack({
        preview: { query_proof_preview: sidecar },
        capture_identity_digest: CAPTURE_IDENTITY_DIGEST
      });
      expect(pack.selected_candidates).toEqual(sidecar.prefix);
      expect(pack.selected_candidates).toEqual(sidecar.candidate_prefix);
      expect(pack.selected_candidates).not.toEqual(["live-1"]);
    });
  });

  describe("observer-target-exception", () => {
    it("keeps production candidates and does not warn when the target pack fails closed", () => {
      const warn = vi.fn();
      const spy = vi.spyOn(deliveryPack, "buildShadowDeliveryPack")
        .mockImplementationOnce(() => {
          throw new ShadowContractError("planted pack failure");
        });
      const trace = captureLive(warn);
      expect(isFailClosedShadowTrace(trace)).toBe(false);
      if (isFailClosedShadowTrace(trace)) throw new Error("expected captured shadow");
      expect(warn).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
      expect(trace.delivery_pack.mode).toBe("unsupported");
      expect(trace.delivery_pack.selected_candidates).toEqual([]);
      expect(trace.delivery_pack.selected_candidates).not.toEqual(trace.prefix_proposal);
      expect(JSON.stringify(trace.query_proof_preview ?? {})).not.toMatch(
        /"first_frontier_size":0/u);
    });
  });
});

const DIGEST = "sha256:1234567890123456789012345678901234567890123456789012345678901234";

function capturedSidecar(
  prefix: readonly string[],
  packMode: NonNullable<QueryProofPreviewSidecar["pack_mode"]>,
  extra: Partial<QueryProofPreviewSidecar> = {}
): QueryProofPreviewSidecar {
  return Object.freeze({
    status: "captured" as const,
    S_infty: Object.freeze([...prefix]),
    prefix: Object.freeze([...prefix]),
    candidate_prefix: Object.freeze([...prefix]),
    answer_bindings: Object.freeze([]),
    pick_reasons: Object.freeze([]),
    reject_reasons: Object.freeze([]),
    contract_digest: DIGEST,
    semantic_feasibility: Object.freeze([]),
    resource_policy: DEFAULT_RESOURCE_FEASIBILITY_POLICY,
    pack_mode: packMode,
    query_digest: DIGEST,
    first_frontier_size: null,
    frontier_depth: null,
    candidate_dispositions: Object.freeze([]),
    ...extra
  });
}

function failedSidecar(): QueryProofPreviewSidecar {
  return Object.freeze({
    status: "failed" as const,
    S_infty: Object.freeze([] as string[]),
    prefix: Object.freeze([] as string[]),
    candidate_prefix: Object.freeze([] as string[]),
    answer_bindings: Object.freeze([]),
    pick_reasons: Object.freeze([]),
    reject_reasons: Object.freeze([]),
    contract_digest: "sha256:preview_unavailable",
    semantic_feasibility: Object.freeze([]),
    resource_policy: DEFAULT_RESOURCE_FEASIBILITY_POLICY,
    reason: "preview failed",
    pack_mode: "unsupported" as const,
    first_frontier_size: null,
    frontier_depth: null,
    candidate_dispositions: Object.freeze([])
  });
}

function plantedCandidate(
  key: string,
  hEligible = true
): ShadowCaptureWalkCandidate {
  return Object.freeze({
    candidate_key: key,
    object_key: key,
    token_cost: 1,
    dimension: "semantic",
    h_eligible: hEligible,
    utility: emptySetUtilityInput(key, key),
    static_frontier_index: null
  });
}

function plantedWalk(params: {
  readonly sInfty?: readonly string[];
  readonly rejects?: ShadowCapturedWalk["walk_rejects"];
  readonly decisions?: ShadowCapturedWalk["decisions"];
}): ShadowCapturedWalk {
  return Object.freeze({
    kind: "captured" as const,
    operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    S_infty: Object.freeze([...(params.sInfty ?? [])]),
    decisions: Object.freeze([...(params.decisions ?? [])]),
    walk_rejects: Object.freeze([...(params.rejects ?? [])])
  });
}

function plantedDecision(
  candidateKey: string,
  maxGCohort: readonly string[] = []
): ShadowCapturedWalk["decisions"][number] {
  return Object.freeze({
    schema_version: 1 as const,
    candidate_key: candidateKey,
    capture_reason: "core_undominated" as const,
    G: Object.freeze({
      answer_binding_position: 1,
      required_proposition_support: 0,
      certified_independent_support: 0
    }),
    G_status: Object.freeze({
      facility: "not_applicable" as const,
      values: "no_match" as const,
      evidence_identity: "unavailable" as const
    }),
    named_novelty: Object.freeze({
      facility_keys: Object.freeze([] as string[]),
      value_pairs: Object.freeze([] as string[]),
      content_ids: Object.freeze([] as string[])
    }),
    novelty_core_known_absence: Object.freeze([]),
    max_g_cohort: Object.freeze([...maxGCohort]),
    equal_g_dominance_rejects: Object.freeze([]),
    deterministic_tail: SHADOW_DETERMINISTIC_TAIL,
    unresolved_pointwise_tradeoff: false,
    h_gate: "none" as const,
    walk_reject: "none" as const,
    static_frontier_index: null
  });
}

function plantedArtifact(params: {
  readonly universe?: readonly string[];
  readonly cycle?: boolean;
  readonly pairs?: readonly Readonly<{
    readonly left: string;
    readonly right: string;
    readonly outcome: PsiV2PairOutcomeV1;
  }>[];
  readonly firstFrontier?: number | null;
  readonly frontierDepth?: number | null;
}): PsiV2AuthorityArtifactV1 {
  const universe = params.universe ?? [];
  return Object.freeze({
    schema_version: 1 as const,
    query_digest: DIGEST,
    request_digest: null,
    snapshot_digest: DIGEST,
    principal_digest: null,
    workspace_id: null,
    generation: null,
    source_authority_digests: Object.freeze([] as string[]),
    candidate_universe: Object.freeze([...universe]),
    candidate_objects: Object.freeze([]),
    observation_status: "observed" as const,
    producer_outcomes: Object.freeze([]),
    pair_outcomes: Object.freeze((params.pairs ?? []).map((row) => Object.freeze({
      left_candidate_key: row.left,
      right_candidate_key: row.right,
      outcome: row.outcome
    }))),
    psi_edges: Object.freeze([] as Array<readonly [string, string]>),
    unresolved_tradeoff_pairs: Object.freeze([] as Array<readonly [string, string]>),
    peeled_layers: Object.freeze([] as Array<readonly string[]>),
    cycle_status: params.cycle === true ? "cycle" as const : "no_cycle" as const,
    first_frontier_size: params.firstFrontier === undefined ? 1 : params.firstFrontier,
    frontier_depth: params.frontierDepth === undefined ? 1 : params.frontierDepth,
    structural_digest: DIGEST as PsiV2AuthorityArtifactV1["structural_digest"]
  });
}

function captureLive(warn: ReturnType<typeof vi.fn> = vi.fn()) {
  const candidates: readonly CoarseRecallCandidate[] = ["cand-a", "cand-b"].map(
    (objectId, index) => ({
      entry: createMemoryEntry({
        object_id: objectId,
        content: `fact ${index}`,
        activation_score: 0.4 + index * 0.1
      }),
      admissionPlanes: ["activation"],
      firstAdmissionPlane: "activation"
    })
  );
  return captureShadowIntegration({
    candidates,
    policy: buildDefaultPolicy({
      strategy: "build",
      taskSurfaceRef: "task-surface-1",
      now: () => "2026-07-12T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    supplementaryData: {
      queryProbes: compileRecallQueryProbes("where is the operator?"),
      ftsRanks: {},
      trigramFtsRanks: {},
      synthesisFtsRanks: {},
      evidenceFtsRanks: {},
      evidenceProjectionMatchesByRef: {},
      sourceProximityScores: {},
      sourceCohortKeys: {},
      structuralScores: {},
      graphExpansionScores: {},
      entitySeedScores: {},
      pathExpansionScores: {},
      pathSuppressionScores: {},
      embeddingSimilarityScores: {},
      evidenceSemanticActivationsByCandidateKey: new Map(),
      graphSupportCounts: {},
      budgetPenaltyFactor: 0,
      plasticityFactors: {},
      graphAndPathColdScore: 0,
      recallsEdgeCount: 0,
      weightTransferAmount: 0,
      evidenceGistsByMemoryId: {},
      governanceCeilingByMemoryId: {}
    },
    tokenEstimator: { estimate: () => 4 },
    warn
  });
}
