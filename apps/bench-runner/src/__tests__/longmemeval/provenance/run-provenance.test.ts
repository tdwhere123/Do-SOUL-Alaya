import { describe, expect, it } from "vitest";
import {
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema,
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME
} from "../../../longmemeval/provenance/run.js";
import {
  buildFixtureRunProvenanceSidecar,
  createRunProvenanceFixture,
  EXTRACTION_CLOSURE,
  registerRunProvenanceRootCleanup
} from "./run-provenance-fixture.js";

const roots = registerRunProvenanceRootCleanup();

describe("LongMemEval run provenance", () => {
  it("archives the validated manifest identity, sequential protocol, and slice switch", async () => {
    const fixture = await createRunProvenanceFixture(roots);
    const { provenance, manifest, crossEncoderCacheRoot } = fixture;

    expect(LONGMEMEVAL_RUN_PROVENANCE_FILENAME).toBe("longmemeval-run-provenance.json");
    expect(provenance.execution).toEqual({
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: null,
      evaluated_count: 1
    });
    expect(provenance.recall_config.conf_slice_compatibility).toBe(true);
    expect(provenance.recall_config.schema_version).toBe(2);
    expect(provenance.seed_capabilities).toEqual({ facet_tags_enabled: true });
    expect(provenance.code).toEqual({
      commit_sha7: "05d98df",
      gate_sha256: null,
      worktree_state_sha256: null,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "2".repeat(64),
        file_count: 17
      }
    });
    expect(provenance.extraction_cache).toMatchObject({
      extraction_model: "cached-model",
      model_family: "cached-family",
      request_profile: "deepseek-v4-nonthinking-v1",
      provider_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      archive_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      system_prompt_sha256: "b".repeat(64),
      dataset_revision: "a".repeat(64),
      coverage: 1,
      fill_status: "complete",
      expected_turns: 10,
      expected_key_set_sha256: EXTRACTION_CLOSURE.expected_key_set_sha256,
      content_closure_sha256: EXTRACTION_CLOSURE.content_closure_sha256
    });
    const builtCache = provenance.extraction_cache;
    if (builtCache?.schema_version !== 3) throw new Error("expected current cache");
    expect(builtCache.supplemental_source_receipt).toMatchObject({
      receipt_sha256: "d".repeat(64),
      physical_provider_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(JSON.stringify(provenance.extraction_cache)).not.toContain("supplement.example");
    expect(JSON.stringify(provenance.extraction_cache)).not.toContain("secret");
    expect(Object.keys(builtCache.content_closure_index ?? {}))
      .toHaveLength(EXTRACTION_CLOSURE.expected_turns);
    expect(provenance.extraction_cache?.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.runtime).toEqual({
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "env",
      embedding_provider_kind: "local_onnx",
      embedding_provider_label: "local_onnx:Xenova/test",
      onnx_threads: 2,
      onnx_model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      embedding_supplement: {
        enabled: true,
        provider_kind: "local_onnx",
        effective_model_id: "Xenova/test",
        model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        effective_schema_version: 1,
        d2q_input: "raw_content"
      },
      answer_rerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      paired_env: {
        ALAYA_EXP_ANSWERS_WITH_CAP: "3",
        ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
        ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
        ALAYA_BENCH_EXTRACTION_MODEL_FAMILY: "cached-family",
        ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true",
        ALAYA_LOCAL_CROSS_ENCODER_MODEL: "Xenova/reranker",
        ALAYA_LOCAL_ONNX_THREADS: "2",
        OFFICIAL_API_GARDEN_MODEL: "cached-model",
        ALAYA_RECALL_ANSWERS_WITH: "1",
        ALAYA_RECALL_FACET_TAGS: "1",
        ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP: "2",
        ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
        ALAYA_CONFLICT_DETECTION_ENABLED: "0",
        ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics"
      }
    });
    expect(provenance.runtime.paired_env).not.toHaveProperty("ALAYA_RECALL_AUTH_HEADER");
    expect(provenance.runtime.paired_env).not.toHaveProperty("ALAYA_EXP_SIGNED_URL");
    expect(JSON.stringify(provenance.runtime.paired_env)).not.toContain(crossEncoderCacheRoot);
    expect(provenance.question_manifest).toMatchObject({
      schema_version: 1,
      variant: "longmemeval_s",
      dataset_sha256: "a".repeat(64),
      target_count: 1,
      selected_id_digest: manifest.selected_id_digest
    });
    expect(provenance.question_manifest?.file_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const sidecar = await buildFixtureRunProvenanceSidecar(fixture);

    expect(sidecar.filename).toBe(LONGMEMEVAL_RUN_PROVENANCE_FILENAME);
    expect(JSON.parse(sidecar.contents)).toEqual(provenance);

    const v1Cache = { ...provenance.extraction_cache! };
    delete (v1Cache as { model_family?: string }).model_family;
    delete (v1Cache as { request_profile?: string }).request_profile;
    for (const field of [
      "fill_status", "window_offset", "window_limit", "expected_turns",
      "expected_key_set_sha256", "content_closure_sha256", "content_closure_index",
      "supplemental_source_receipt"
    ]) delete (v1Cache as Record<string, unknown>)[field];
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      extraction_cache: { ...v1Cache, schema_version: 1 }
    }).success).toBe(true);
    const legacyRuntime = { ...provenance.runtime };
    delete (legacyRuntime as { answer_rerank?: unknown }).answer_rerank;
    delete (legacyRuntime as { embedding_supplement?: unknown }).embedding_supplement;
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      runtime: legacyRuntime
    }).success).toBe(true);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      runtime: {
        ...provenance.runtime,
        answer_rerank: {
          enabled: true,
          provider_kind: "local_onnx_cross_encoder",
          effective_model_id: "Xenova/reranker"
        }
      }
    }).success).toBe(false);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      extraction_cache: { ...v1Cache, schema_version: 99 }
    }).success).toBe(false);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      extraction_cache: { ...v1Cache, schema_version: 1, model_family: "forged" }
    }).success).toBe(false);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      extraction_cache: {
        ...v1Cache,
        schema_version: 2,
        model_family: "cached-family"
      }
    }).success).toBe(true);
    expect(LongMemEvalRunProvenanceSchema.safeParse({
      ...provenance,
      extraction_cache: {
        ...v1Cache,
        schema_version: 2,
        model_family: "cached-family",
        request_profile: "provider-default-v1"
      }
    }).success).toBe(false);

    expect(isLongMemEvalRunProvenanceGateEligible(provenance)).toBe(false);
    const currentProvenance = LongMemEvalRunProvenanceSchema.parse({
      ...provenance,
      code: {
        ...provenance.code,
        commit_sha: "05d98df" + "0".repeat(33),
        gate_contract_path: "/tmp/frozen-contract.json",
        gate_sha256: "d".repeat(64),
        worktree_state_sha256: "1".repeat(64),
        worktree_clean: true
      }
    });
    expect(isLongMemEvalRunProvenanceGateEligible(currentProvenance)).toBe(true);
    const currentCache = currentProvenance.extraction_cache;
    if (currentCache?.schema_version !== 3) {
      throw new Error("current provenance fixture must use extraction schema v3");
    }
    const digestOnlyCache = { ...currentCache };
    delete (digestOnlyCache as Record<string, unknown>).content_closure_index;
    const digestOnlyProvenance = LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      extraction_cache: digestOnlyCache
    });
    expect(isLongMemEvalRunProvenanceGateEligible(digestOnlyProvenance)).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      extraction_cache: {
        ...currentCache,
        window_offset: 1
      }
    })).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      extraction_cache: {
        ...currentCache,
        window_limit: 0
      }
    })).toBe(false);
    const statuslessCache = { ...currentCache };
    for (const field of [
      "fill_status", "window_offset", "window_limit", "expected_turns",
      "expected_key_set_sha256", "content_closure_sha256", "content_closure_index"
    ]) delete (statuslessCache as Record<string, unknown>)[field];
    const statuslessProvenance = LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      extraction_cache: statuslessCache
    });
    expect(isLongMemEvalRunProvenanceGateEligible(statuslessProvenance)).toBe(false);
    const inProgressProvenance = LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      extraction_cache: {
        ...currentCache,
        fill_status: "in_progress",
        content_closure_sha256: undefined,
        content_closure_index: undefined
      }
    });
    expect(isLongMemEvalRunProvenanceGateEligible(inProgressProvenance)).toBe(false);
    const incompleteScopedCache = { ...currentCache };
    delete (incompleteScopedCache as Record<string, unknown>).expected_key_set_sha256;
    const incompleteScopedProvenance = LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      extraction_cache: incompleteScopedCache
    });
    expect(isLongMemEvalRunProvenanceGateEligible(incompleteScopedProvenance)).toBe(false);
    const contentUnboundCache = { ...currentCache };
    delete (contentUnboundCache as Record<string, unknown>).content_closure_sha256;
    expect(isLongMemEvalRunProvenanceGateEligible(LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      extraction_cache: contentUnboundCache
    }))).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      extraction_cache: {
        ...currentCache,
        dataset_revision: "unpinned"
      }
    })).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      extraction_cache: {
        ...currentCache,
        dataset_revision: "9".repeat(64)
      }
    })).toBe(false);
    const legacyRecallIdentity = LongMemEvalRunProvenanceSchema.parse({
      ...currentProvenance,
      recall_config: { ...currentProvenance.recall_config, schema_version: 1 }
    });
    expect(isLongMemEvalRunProvenanceGateEligible(legacyRecallIdentity)).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        paired_env: {
            ...currentProvenance.runtime.paired_env,
          ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false"
        }
      }
    })).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        answer_rerank: { enabled: false }
      }
    })).toBe(false);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: legacyRuntime
    })).toBe(false);
    expect(() => isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        paired_env: {
            ...currentProvenance.runtime.paired_env,
          ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "sometimes"
        }
      }
    })).toThrow(/ALAYA_ENABLE_EMBEDDING_SUPPLEMENT/u);
    expect(() => isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        paired_env: {
            ...currentProvenance.runtime.paired_env,
          ALAYA_RECALL_D2Q: "sometimes"
        }
      }
    })).toThrow(/ALAYA_RECALL_D2Q/u);
    expect(() => isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        paired_env: {
            ...currentProvenance.runtime.paired_env,
          ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "sometimes"
        }
      }
    })).toThrow(/ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK/u);
    expect(isLongMemEvalRunProvenanceGateEligible({
      ...currentProvenance,
      runtime: {
          ...currentProvenance.runtime,
        embedding_mode: "disabled",
        embedding_provider_kind: "openai",
        embedding_provider_label: "none",
        embedding_supplement: { enabled: false },
        onnx_model_artifact_sha256: "3".repeat(64)
      }
    })).toBe(false);
  });

});
