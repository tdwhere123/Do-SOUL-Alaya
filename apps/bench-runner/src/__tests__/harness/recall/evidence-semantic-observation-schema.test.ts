import { describe, expect, it } from "vitest";
import {
  EmbeddingRecallService,
  type EvidenceCandidateScoringReceipt
} from "@do-soul/alaya-core";
import {
  parseBenchRecallDiagnosticsForRun
} from "../../../harness/recall/recall-diagnostics-schema.js";

const FUSION_STREAMS = [
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "entity_seed",
  "path_expansion",
  "temporal_recency",
  "workspace_activation"
] as const;

describe("evidence-semantic observation diagnostics contract", () => {
  it("parses live contentHash stamps through bench recall diagnostics", async () => {
    const receipt = await scoreAttributedReceipt();
    const parsed = parseBenchRecallDiagnosticsForRun(diagnosticsWithReceipt(receipt));
    const observations = parsed.candidates[0]?.deep_head_trace
      ?.evidence_semantic_activation?.observations;

    expect(observations).toHaveLength(2);
    expect(new Set(observations?.map((row) => row.contentHash))).toEqual(
      new Set([receipt.winner.contentHash])
    );
    expect(receipt.winner.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("parses pre-stamp evidence-semantic observations without contentHash", async () => {
    const receipt = stripContentHash(await scoreAttributedReceipt());

    expect(receipt.winner).not.toHaveProperty("contentHash");
    expect(parseBenchRecallDiagnosticsForRun(diagnosticsWithReceipt(receipt))
      .candidates[0]?.deep_head_trace?.evidence_semantic_activation?.observations
      .every((row) => row.contentHash === undefined)).toBe(true);
  });
});

async function scoreAttributedReceipt(): Promise<EvidenceCandidateScoringReceipt> {
  const service = new EmbeddingRecallService({
    embeddingRepo: { listByObjectIds: async () => [] },
    provider: {
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      isAvailable: true,
      embedTexts: async (texts) => texts.map(() => new Float32Array([1, 0]))
    },
    eventLogRepo: {
      append: (entry) => ({
        ...entry,
        event_id: "event-1",
        created_at: "2026-08-13T00:00:00.000Z",
        revision: 1
      }),
      queryByEntity: async () => []
    }
  });
  const result = await service.scoreEvidenceCandidates({
    workspaceId: "workspace-1",
    runId: null,
    queryText: "query",
    preparedQuery: null,
    candidates: [{
      candidateKey: "memory:1",
      evidenceObjectId: "evidence-1",
      documentIdentity: "owner_gist_600",
      content: "shared evidence"
    }, {
      candidateKey: "memory:1",
      evidenceObjectId: "evidence-1",
      documentIdentity: "owner",
      content: "shared evidence"
    }]
  });
  const scored = result.activationsByCandidateKey.get("memory:1");
  if (scored === undefined) throw new Error("expected scored evidence receipt");
  const observations = scored.observations.map((observation) => ({
    ...observation,
    projection: null
  }));
  return JSON.parse(JSON.stringify({
    ...scored,
    winner: observations[0],
    observations
  })) as EvidenceCandidateScoringReceipt;
}

function stripContentHash(
  receipt: EvidenceCandidateScoringReceipt
): EvidenceCandidateScoringReceipt {
  return {
    ...receipt,
    winner: omitContentHash(receipt.winner),
    observations: receipt.observations.map(omitContentHash)
  };
}

function omitContentHash<T extends { readonly contentHash?: string }>(
  row: T
): Omit<T, "contentHash"> {
  const { contentHash: _contentHash, ...rest } = row;
  return rest;
}

function diagnosticsWithReceipt(receipt: EvidenceCandidateScoringReceipt) {
  return {
    query_probes: {
      normalized_query: "question",
      object_ids: [],
      subject_hints: [],
      evidence_refs: [],
      run_ids: [],
      surface_ids: [],
      file_paths: [],
      command_names: [],
      package_names: [],
      task_refs: [],
      dimensions: [],
      scope_classes: [],
      domain_tags: [],
      lexical_terms: [],
      expanded_terms: [],
      phrases: [],
      char_ngrams: [],
      date_terms: []
    },
    total_scanned: 1,
    candidate_pool_count: 1,
    pre_budget_count: 1,
    delivered_count: 1,
    embedding_provider_status: "provider_not_requested",
    provider_degradation_reason: null,
    answer_rerank_status: "not_requested",
    answer_rerank_expected_count: 0,
    answer_rerank_scored_count: 0,
    answer_rerank_failure_class: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    fusion_breakdown: [],
    fine_assessment_pruned_candidates: [],
    candidates: [{
      candidate_key: "workspace_local:memory_entry:memory-1",
      object_id: "memory-1",
      object_kind: "memory_entry",
      origin_plane: "workspace_local",
      admission_planes: ["lexical"],
      plane_first_admitted: "lexical",
      plane_winning_admission: "lexical",
      pre_budget_rank: 1,
      selection_order: 1,
      fused_rank: 1,
      fused_score: 0.4,
      per_stream_rank: Object.fromEntries(FUSION_STREAMS.map((key) => [key, null])),
      fused_rank_contribution_per_stream: Object.fromEntries(
        FUSION_STREAMS.map((key) => [key, 0])
      ),
      final_rank: 1,
      dropped_reason: null,
      within_budget: true,
      relevance_score: 0.4,
      lexical_rank: null,
      structural_score: 0,
      score_factors: {},
      source_channels: ["lexical"],
      path_expansion_sources: [],
      deep_head_trace: {
        lexical_agreement: 0,
        evidence_agreement: 0,
        resolved_evidence: 0,
        embedding_signal: null,
        fusion_baseline_used: false,
        resolved_score: 0,
        score_source: "evidence_only",
        evidence_semantic_activation: receipt
      }
    }]
  };
}
