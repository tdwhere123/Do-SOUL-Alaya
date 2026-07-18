import { vi } from "vitest";
import {
  createLongMemEvalSelectionContractIdentity,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import {
  buildPayload,
  makeSeedExtractionPath,
  withEligibleMeasurementContract
} from "../../../../../../packages/eval/src/__tests__/gates/release-gates-fixture.js";
import type {
  VerifiedRecallEvalPromotionEntry,
  VerifiedRecallEvalPromotionEntryData
} from "../../../longmemeval/promotion/verifiers/entry-verifier.js";
import { LongMemEvalMatrixPromotionContractSchema } from "../../../longmemeval/promotion/schema/contract.js";
import { authorizeVerifiedLongMemEvalMatrix } from "../../../longmemeval/promotion/schema/matrix-validator.js";
import { buildEffectiveRecallConfigIdentity } from "../../../longmemeval/provenance/effective-recall-config.js";

vi.mock("../../../longmemeval/promotion/verifiers/entry-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import(
    "../../../longmemeval/promotion/verifiers/entry-verifier.js"
  )>();
  return {
    ...actual,
    verifiedRecallEvalPromotionEntryData: (entry: VerifiedRecallEvalPromotionEntry) => {
      const testData = (entry as { readonly testData?: unknown }).testData;
      return testData ?? actual.verifiedRecallEvalPromotionEntryData(entry);
    }
  };
});

function authorizePromotionMatrixFixture(
  input: Parameters<typeof authorizeVerifiedLongMemEvalMatrix>[0]
) {
  return authorizeVerifiedLongMemEvalMatrix(input);
}

function matrixFixture() {
  const controlPayload = productPayload("control", "2026-07-16T00:00:01.000Z");
  const productPayloadValue = productPayload("product", "2026-07-16T00:00:02.000Z");
  const sourceSelection = controlPayload.selection_contract!;
  const nextSelection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: sourceSelection.dataset_sha256,
    assignments: Array.from({ length: 500 }, (_, index) => ({
      question_id: `question-${index + 1}`,
      dataset_cohort: "answerable" as const
    }))
  });
  const contract = LongMemEvalMatrixPromotionContractSchema.parse({
    schema_version: 1,
    kind: "longmemeval_matrix_promotion_contract",
    policy_version: "longmemeval-product-default-v1",
    code: {
      commit_sha: "abc1234" + "0".repeat(33),
      commit_sha7: "abc1234",
      worktree_state_sha256: "b".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "8".repeat(64),
        file_count: 1
      }
    },
    dataset: { variant: "longmemeval_s" },
    selection: {
      policy_version: "dataset-prefix-full-snapshot-v1",
      source_prefix_count: 100,
      target_full_count: 500
    },
    snapshot: {
      db_path: "snapshot/source-100.db",
      manifest_sha256: "f".repeat(64)
    },
    execution_order: ["A", "B", "C", "D", "B2"],
    matrix: { entries: [
      contractEntry(false, false, "cell-a"),
      contractEntry(true, false, "cell-b"),
      contractEntry(false, true, "cell-c"),
      contractEntry(true, true, "cell-d")
    ] },
    product_default_replication: {
      cell: "B2",
      treatment: { embedding_supplement: true, answer_rerank: false },
      evidence_root: "cell-b2"
    },
    material_effect_policy: materialEffectPolicy()
  });
  const payloads = [
    controlPayload,
    productPayloadValue,
    { ...controlPayload, run_at: "2026-07-16T00:00:03.000Z" },
    { ...productPayloadValue, run_at: "2026-07-16T00:00:04.000Z" }
  ];
  return {
    contract,
    contractSha256: "a".repeat(64),
    sourceSelection,
    nextSelection,
    cells: contract.matrix.entries.map((entry, index) => ({
      ...testCell(
        entry.evidence_root,
        entryData(payloads[index]!, entry.treatment, String(index + 1))
      )
    })),
    productDefaultReplication: testCell(
      contract.product_default_replication.evidence_root,
      entryData(
        { ...productPayloadValue, run_at: "2026-07-16T00:00:05.000Z" },
        contract.product_default_replication.treatment,
        "5"
      )
    )
  };
}

function testCell(evidenceRoot: string, data: VerifiedRecallEvalPromotionEntryData) {
  return {
    evidenceRoot,
    data,
    entry: { testData: data } as unknown as VerifiedRecallEvalPromotionEntry
  };
}

function productPayload(
  effect: "control" | "product",
  runAt: string
): KpiPayload {
  const base = buildPayload("abc1234");
  const eligible = withEligibleMeasurementContract({
    ...base,
    bench_name: "public",
    split: "longmemeval-s",
    recall_pipeline_version: "recall-eval-v1",
    embedding_provider: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
    dataset: {
      name: "longmemeval_s",
      size: 100,
      source: "fixture",
      checksum_sha256: "d".repeat(64)
    },
    sample_size: 100,
    evaluated_count: 100,
    kpi: {
      ...base.kpi,
      r_at_5: 0.95,
      latency_ms_p50: 100,
      latency_ms_p95: 100,
      seed_extraction_path: makeSeedExtractionPath()
    }
  });
  const answerableCount = 94;
  const hitCount = effect === "control" ? 80 : 89;
  const assignments = Array.from({ length: 100 }, (_, index) => ({
    question_id: `question-${index + 1}`,
    dataset_cohort: index < answerableCount
      ? "answerable" as const
      : "abstention" as const
  }));
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: eligible.selection_contract!.dataset_sha256,
    assignments
  });
  return {
    ...eligible,
    run_at: runAt,
    answerable_evaluated_count: answerableCount,
    selection_contract: selection,
    recall_eval_attribution: recallAttribution(selection),
    kpi: {
      ...eligible.kpi,
      r_at_1: effect === "control" ? 0.8 : 0.81,
      r_at_5: hitCount / answerableCount,
      r_at_10: effect === "control" ? 0.9 : 0.91,
      token_saved_ratio_vs_full_prompt: 0.9,
      full_gold_coverage: {
        gold_bearing_questions: answerableCount,
        full_gold_at_5: effect === "control" ? 0.7 : 0.71,
        full_gold_at_10: 0.8,
        gold_coverage_at_5: effect === "control" ? 0.75 : 0.76,
        gold_coverage_at_10: 0.85,
        pool_recall_at_50: 0.9,
        pool_recall_at_100: 0.95
      },
      provider_returned_rate: 1,
      provider_pending_rate: 0,
      provider_failed_rate: 0,
      provider_not_requested_rate: 0,
      r_at_5_with_embedding_returned: 0.95,
      recall_token_economy: recallTokenEconomy(100),
      quality_metrics: {
        ...eligible.kpi.quality_metrics!,
        measurement_cohort_counts: {
          evaluated: 100,
          non_abstention: answerableCount,
          abstention: 6,
          scorable_answerable: answerableCount,
          unscorable_answerable: 0,
          hit_at_5: hitCount,
          miss_at_5: answerableCount - hitCount
        },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: 6,
          scored: 0,
          unscorable: 6,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      },
      per_scenario: assignments.map((assignment, index) => ({
        id: assignment.question_id,
        version: 1,
        hit_at_5: index < hitCount,
        scorable: assignment.dataset_cohort === "answerable",
        measurement_cohort: assignment.dataset_cohort === "answerable"
          ? "answerable" as const
          : "dataset_declared_abstention" as const,
        tier: "hot" as const
      }))
    }
  } as KpiPayload;
}

function materialEffectPolicy() {
  return {
    control_cell: "A" as const,
    product_cell: "B" as const,
    answerable_count: 94 as const,
    declared_abstention_count: 6 as const,
    directional_metrics: [
      "r_at_1", "r_at_5", "r_at_10", "full_gold_at_5"
    ] as const,
    token_non_regression_metric: "token_saved_ratio_vs_full_prompt" as const,
    minimum_net_r_at_5_wins: 5 as const,
    mcnemar: {
      method: "exact_two_sided" as const,
      p_value_max_exclusive: 0.05 as const
    }
  };
}

function recallAttribution(
  selection: NonNullable<KpiPayload["selection_contract"]>
): NonNullable<KpiPayload["recall_eval_attribution"]> {
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    embedding_mode: "env",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
    onnx_threads: null,
    onnx_model_artifact_sha256: "4".repeat(64),
    embedding_supplement: biIdentity(),
    answer_rerank: { enabled: false },
    recall_config: recallConfig(),
    evaluation_slice: {
      offset: 0,
      limit: null,
      evaluated_count: selection.selected_count,
      question_id_digest: selection.selected_id_digest
    },
    hydration_binding: {
      dataset_sha256: selection.dataset_sha256,
      source: "external_expected_sha256"
    },
    snapshot_binding: {
      commit_sha7: "abc1234",
      gate_sha256: "a".repeat(64),
      worktree_state_sha256: "b".repeat(64),
      extraction_cache_manifest_sha256: "c".repeat(64),
      extraction_cache_requested_turns: 100,
      extraction_cache_cached_turns: 100,
      extraction_cache_coverage: 1,
      dataset_sha256: selection.dataset_sha256,
      question_id_digest: selection.selected_id_digest,
      snapshot_manifest_sha256: "f".repeat(64),
      producer_recall_pipeline_version: "recall-eval-v1",
      consumer_recall_pipeline_version: "recall-eval-v1",
      producer_schema_migration_version: 1
    }
  };
}

function entryData(
  payload: KpiPayload,
  treatment: { readonly embedding_supplement: boolean; readonly answer_rerank: boolean },
  bundleDigit: string
): VerifiedRecallEvalPromotionEntryData {
  const bi = treatment.embedding_supplement ? biIdentity() : { enabled: false as const };
  const cross = treatment.answer_rerank ? crossIdentity() : { enabled: false as const };
  return {
    entryRoot: `/fixture/cell-${bundleDigit}`,
    treatment,
    manifest: {
      schema_version: 1,
      kind: "longmemeval_evidence_bundle",
      profile: "recall_eval",
      run: {
        slug: `cell-${bundleDigit}`,
        bench_name: "public",
        split: "longmemeval-s",
        run_at: payload.run_at,
        alaya_commit: payload.alaya_commit,
        dataset_sha256: payload.selection_contract!.dataset_sha256,
        selection_manifest_sha256: null,
        question_id_digest: payload.selection_contract!.selected_id_digest,
        selection_contract: payload.selection_contract!,
        candidate_pool_complete: true,
        provenance_complete: true
      },
      evidence_status: "complete",
      artifacts: [],
      bundle_sha256: bundleDigit.repeat(64)
    },
    payload,
    provenance: {
      schema_version: 1,
      dataset_sha256: payload.selection_contract!.dataset_sha256,
      selection: payload.selection_contract,
      code: {
        commit_sha7: "abc1234",
        commit_sha: "abc1234" + "0".repeat(33),
        gate_sha256: "a".repeat(64),
        gate_contract_path: "/fixture/contract.json",
        worktree_state_sha256: "b".repeat(64),
        worktree_clean: true,
        executed_dist: {
          algorithm: "sha256-reachable-path-file-sha256-v1",
          sha256: "8".repeat(64),
          file_count: 1
        }
      },
      extraction_cache: {
        schema_version: 3,
        manifest_sha256: "c".repeat(64),
        extraction_model: "fixture",
        model_family: "fixture",
        request_profile: "provider-default-v1",
        provider_url: "redacted",
        system_prompt_sha256: "7".repeat(64),
        cache_key_algo: "fixture-v1",
        dataset: "longmemeval_s",
        dataset_revision: payload.selection_contract!.dataset_sha256,
        requested_turns: 100,
        cached_turns: 100,
        coverage: 1,
        storage: "git-tracked",
        built_at: "2026-07-16T00:00:00.000Z",
        builder: "fixture"
      },
      runtime: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        embedding_mode: treatment.embedding_supplement ? "env" : "disabled",
        embedding_provider_kind: "local_onnx",
        embedding_provider_label: treatment.embedding_supplement
          ? `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`
          : "none",
        onnx_threads: null,
        ...(treatment.embedding_supplement
          ? { onnx_model_artifact_sha256: "4".repeat(64) }
          : {}),
        embedding_supplement: bi,
        answer_rerank: cross,
        paired_env: {
          ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: String(treatment.embedding_supplement),
          ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: String(treatment.answer_rerank)
        }
      },
      execution: {
        protocol: "sequential",
        concurrency: 1,
        offset: 0,
        limit: null,
        evaluated_count: 100
      },
      recall_config: { conf_slice_compatibility: false, ...recallConfig() },
      seed_capabilities: { facet_tags_enabled: false },
      question_manifest: null
    },
    snapshot: promotionSnapshot(),
    diagnosticsRuntime: {
      embedding_supplement: bi,
      answer_rerank: cross
    }
  } as VerifiedRecallEvalPromotionEntryData;
}

function promotionSnapshot(): VerifiedRecallEvalPromotionEntryData["snapshot"] {
  return {
    manifestSha256: "f".repeat(64),
    dbSha256: "5".repeat(64),
    sidecarSha256: "6".repeat(64),
    goldForQuestion: () => undefined,
    measurementForQuestion: () => undefined,
    producerGateSha256: "a".repeat(64),
    producerExtractionCacheJson: JSON.stringify({ manifest_sha256: "c".repeat(64) }),
    recallPipelineVersion: "recall-eval-v1",
    schemaMigrationVersion: 1
  };
}

function contractEntry(bi: boolean, cross: boolean, evidenceRoot: string) {
  return {
    treatment: { embedding_supplement: bi, answer_rerank: cross },
    evidence_root: evidenceRoot
  };
}

function biIdentity() {
  return {
    enabled: true as const,
    provider_kind: "local_onnx" as const,
    effective_model_id: DEFAULT_LOCAL_ONNX_MODEL_ID,
    model_artifact_sha256: "4".repeat(64),
    effective_schema_version: 1,
    d2q_input: "raw_content" as const
  };
}

function crossIdentity() {
  return {
    enabled: true as const,
    provider_kind: "local_onnx_cross_encoder" as const,
    effective_model_id: "fixture-cross",
    model_artifact_sha256: "5".repeat(64)
  };
}

function withOpenAiEmbeddingProvider(
  data: VerifiedRecallEvalPromotionEntryData
): VerifiedRecallEvalPromotionEntryData {
  const embedding = data.treatment.embedding_supplement
    ? {
        enabled: true as const,
        provider_kind: "openai" as const,
        effective_model_id: "text-embedding-3-small",
        effective_schema_version: 1,
        d2q_input: "raw_content" as const
      }
    : { enabled: false as const };
  return {
    ...data,
    provenance: {
      ...data.provenance,
      runtime: {
        ...data.provenance.runtime,
        embedding_provider_kind: "openai",
        embedding_provider_label: embedding.enabled
          ? `openai:${embedding.effective_model_id}`
          : "none",
        onnx_model_artifact_sha256: undefined,
        embedding_supplement: embedding
      }
    },
    diagnosticsRuntime: {
      ...data.diagnosticsRuntime,
      embedding_supplement: embedding
    }
  } as VerifiedRecallEvalPromotionEntryData;
}

function withNonProductLocalBi(
  data: VerifiedRecallEvalPromotionEntryData,
  variant: "custom_model" | "d2q"
): VerifiedRecallEvalPromotionEntryData {
  const runtime = data.provenance.runtime;
  const modelId = variant === "custom_model" ? "custom/local-model" :
    DEFAULT_LOCAL_ONNX_MODEL_ID;
  const embedding = data.treatment.embedding_supplement
    ? {
        ...biIdentity(),
        effective_model_id: modelId,
        ...(variant === "d2q"
          ? { effective_schema_version: 2, d2q_input: "content_plus_hq" as const }
          : {})
      }
    : { enabled: false as const };
  return {
    ...data,
    provenance: {
      ...data.provenance,
      runtime: {
        ...runtime,
        embedding_provider_label: embedding.enabled
          ? `local_onnx:${modelId}`
          : "none",
        embedding_supplement: embedding,
        paired_env: {
          ...runtime.paired_env,
          ...(variant === "custom_model"
            ? { ALAYA_LOCAL_EMBEDDING_MODEL: modelId }
            : { ALAYA_RECALL_D2Q: "true" })
        }
      }
    },
    diagnosticsRuntime: {
      ...data.diagnosticsRuntime,
      embedding_supplement: embedding
    }
  } as VerifiedRecallEvalPromotionEntryData;
}

function withOnnxThreads(
  data: VerifiedRecallEvalPromotionEntryData,
  threads: number
): VerifiedRecallEvalPromotionEntryData {
  const attribution = data.payload.recall_eval_attribution!;
  return {
    ...data,
    payload: {
      ...data.payload,
      recall_eval_attribution: { ...attribution, onnx_threads: threads }
    },
    provenance: {
      ...data.provenance,
      runtime: {
        ...data.provenance.runtime,
        onnx_threads: threads,
        paired_env: {
          ...data.provenance.runtime.paired_env,
          ALAYA_LOCAL_ONNX_THREADS: String(threads)
        }
      }
    }
  } as VerifiedRecallEvalPromotionEntryData;
}

function recallConfig() {
  return buildEffectiveRecallConfigIdentity({}, {
    maxResults: 10,
    conflictAwareness: true
  });
}

function recallTokenEconomy(count: number) {
  const stat = (value: number) => ({ mean: value, p50: value, p95: value, max: value });
  return {
    schema_version: "bench-recall-token-economy.v1" as const,
    sample_count: count,
    delivered_context_tokens_estimate: stat(10),
    coarse_pool_size: stat(5),
    fine_evaluated: stat(3),
    fine_pruned_count: stat(2),
    fine_priority_overflow_count: stat(0),
    fusion_families_with_hits: stat(1),
    embedding_inference_calls: stat(1)
  };
}

export {
  authorizePromotionMatrixFixture,
  matrixFixture,
  testCell,
  withNonProductLocalBi,
  withOnnxThreads,
  withOpenAiEmbeddingProvider
};
