import { vi } from "vitest";
import {
  createLongMemEvalSelectionContractIdentity,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import type {
  VerifiedRecallEvalPromotionEntry,
  VerifiedRecallEvalPromotionEntryData
} from "../../../longmemeval/promotion/verifiers/entry-verifier.js";
import { LongMemEvalMatrixPromotionContractSchema } from "../../../longmemeval/promotion/schema/contract.js";
import { authorizeVerifiedLongMemEvalMatrix } from "../../../longmemeval/promotion/schema/matrix-validator.js";
import {
  biEncoderIdentityFixture,
  productPayloadFixture,
  recallConfigFixture
} from "./fixtures/matrix-payload.js";

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
  const controlPayload = productPayloadFixture("control", "2026-07-16T00:00:01.000Z");
  const productPayloadValue = productPayloadFixture("product", "2026-07-16T00:00:02.000Z");
  const sourceSelection = controlPayload.selection_contract!;
  const nextSelection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: sourceSelection.dataset_sha256,
    assignments: Array.from({ length: 500 }, (_, index) => ({
      question_id: `question-${index + 1}`,
      dataset_cohort: "answerable" as const
    }))
  });
  const contract = LongMemEvalMatrixPromotionContractSchema.parse({
    schema_version: 2,
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
    absolute_quality_policy: absoluteQualityPolicy(),
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

function absoluteQualityPolicy() {
  return {
    product_cell: "B" as const,
    replication_cell: "B2" as const,
    metric: "r_at_5" as const,
    cohort: "answerable" as const,
    expected_denominator: 94 as const,
    minimum_hits: 85 as const
  };
}

function entryData(
  payload: KpiPayload,
  treatment: { readonly embedding_supplement: boolean; readonly answer_rerank: boolean },
  bundleDigit: string
): VerifiedRecallEvalPromotionEntryData {
  const bi = treatment.embedding_supplement
    ? biEncoderIdentityFixture()
    : { enabled: false as const };
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
      recall_config: { conf_slice_compatibility: false, ...recallConfigFixture() },
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
        ...biEncoderIdentityFixture(),
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

export {
  authorizePromotionMatrixFixture,
  matrixFixture,
  testCell,
  withNonProductLocalBi,
  withOnnxThreads,
  withOpenAiEmbeddingProvider
};
