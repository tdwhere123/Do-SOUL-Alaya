import { describe, expect, it } from "vitest";
import {
  assertBiEncoderRunActivation,
  assertBiEncoderTreatmentActive,
  assertEmbeddingTreatmentDiagnosticsPresent,
  readBiEncoderCandidateSimilarities,
  requiresEmbeddingTreatmentDiagnostics
} from "../../../harness/embedding/embedding-treatment-activation.js";
import {
  resolveBenchEmbeddingSchemaVersion
} from "../../../harness/daemon/handle/daemon-handle-ops-support.js";
import {
  applyBenchDaemonEnvironment,
  createBenchDaemonLaunchConfig,
  resolveBenchDaemonManagedEnvKeys
} from "../../../harness/daemon/daemon-environment.js";
import {
  recallEvalEmbeddingMode,
  recallEvalEmbeddingProviderKind
} from "../../../runs/lifecycle/recall-eval/recall-eval-runtime.js";

describe("embedding treatment activation", () => {
  it("accepts an observed finite zero similarity", () => {
    expect(() => assertBiEncoderTreatmentActive({
      providerState: "provider_returned",
      providerDegradationReason: null,
      embeddingSimilarities: [0]
    })).not.toThrow();
  });

  it("reads canonical capture observations before legacy candidate factors", () => {
    expect(readBiEncoderCandidateSimilarities({
      capture_receipt: {
        observations_by_candidate_key: {
          candidate: {
            lineages: {
              embedding: { envelope: { state: "observed", value: 0.4 } }
            }
          }
        }
      },
      candidates: [{ score_factors: { embedding_similarity: 0.9 } }]
    })).toEqual([0.4]);
  });

  it.each([
    ["missing", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("rejects %s candidate evidence even when workspace rows were scanned", (_label, value) => {
    expect(() => assertBiEncoderTreatmentActive({
      providerState: "provider_returned",
      providerDegradationReason: null,
      embeddingSimilarities: [value],
      workspaceScannedCount: 2,
      workspaceTruncated: false,
      workspaceProviderKind: "local_onnx",
      workspaceModelId: "fixture-bi",
      workspaceSchemaVersion: 1
    })).toThrow(/bi-encoder treatment activation failed/u);
  });

  it.each([
    ["zero", 0],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY]
  ])("rejects an observed %s similarity key in a disabled control cell", (_label, value) => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_not_requested",
      provider_degradation_reason: null,
      candidates: [{ score_factors: { embedding_similarity: value } }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false" }))
      .toThrow(/control activation failed/u);
  });

  it("accepts a disabled control cell with no embedding evidence key", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_not_requested",
      provider_degradation_reason: null,
      candidates: [{ score_factors: {} }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false" })).not.toThrow();
  });

  it("rejects an enabled cell when evidence candidate scoring failed", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      evidence_embedding_status: "failed",
      evidence_embedding_expected_count: 4,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 1,
      evidence_embedding_failure_class: "candidate_embedding_failed",
      candidates: [{ score_factors: { embedding_similarity: 0.8 } }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }))
      .toThrow(/evidence embedding treatment activation failed/u);
  });

  it("rejects an enabled cell when evidence candidate scoring is incomplete", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      evidence_embedding_status: "returned",
      evidence_embedding_expected_count: 4,
      evidence_embedding_scored_count: 3,
      evidence_embedding_inference_calls: 1,
      evidence_embedding_failure_class: null,
      candidates: [{ score_factors: { embedding_similarity: 0.8 } }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }))
      .toThrow(/evidence embedding treatment activation failed/u);
  });

  it("accepts fully scored evidence embeddings served without inference calls", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      evidence_embedding_status: "returned",
      evidence_embedding_expected_count: 4,
      evidence_embedding_scored_count: 4,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null,
      candidates: [{ score_factors: { embedding_similarity: 0.8 } }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" })).not.toThrow();
  });

  it("rejects an enabled benchmark diagnostic without answer-feature candidates", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      evidence_embedding_status: "returned",
      evidence_embedding_expected_count: 4,
      evidence_embedding_scored_count: 4,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null,
      candidates: []
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }))
      .toThrow(/scored_candidates=0/u);
  });

  it.each([
    ["missing", {}],
    ["not requested", {
      evidence_embedding_status: "not_requested",
      evidence_embedding_expected_count: 0,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null
    }]
  ])("rejects %s evidence telemetry in an enabled cell", (_label, evidence) => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      candidates: [{ score_factors: { embedding_similarity: 0.8 } }],
      ...evidence
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }))
      .toThrow(/evidence embedding treatment activation failed/u);
  });

  it("accepts explicit not-applicable evidence telemetry in an enabled cell", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_returned",
      provider_degradation_reason: null,
      evidence_embedding_status: "not_applicable",
      evidence_embedding_expected_count: 0,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null,
      candidates: [{ score_factors: { embedding_similarity: 0.8 } }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" })).not.toThrow();
  });

  it("rejects evidence candidate scoring in a disabled control cell", () => {
    expect(() => assertBiEncoderRunActivation({
      embedding_provider_status: "provider_not_requested",
      provider_degradation_reason: null,
      evidence_embedding_status: "returned",
      evidence_embedding_expected_count: 1,
      evidence_embedding_scored_count: 1,
      evidence_embedding_inference_calls: 1,
      evidence_embedding_failure_class: null,
      candidates: [{ score_factors: {} }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false" }))
      .toThrow(/control activation failed/u);
  });

  it.each([
    ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
    ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "false"]
  ] as const)("requires diagnostics for explicit %s=%s", (name, value) => {
    const env = { [name]: value };
    expect(requiresEmbeddingTreatmentDiagnostics(env)).toBe(true);
    expect(() => assertEmbeddingTreatmentDiagnosticsPresent(undefined, env))
      .toThrow(/diagnostics missing/u);
  });

  it("does not require treatment diagnostics without an override", () => {
    expect(requiresEmbeddingTreatmentDiagnostics({})).toBe(false);
    expect(() => assertEmbeddingTreatmentDiagnosticsPresent(undefined, {})).not.toThrow();
  });

  it("rejects the retired local cross-encoder treatment", () => {
    expect(() => requiresEmbeddingTreatmentDiagnostics({
      ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true"
    })).toThrow(/local cross-encoder reranking is retired/u);
    expect(requiresEmbeddingTreatmentDiagnostics({
      ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false"
    })).toBe(false);
  });

  it.each([
    ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "default"],
    ["ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK", "on"]
  ] as const)("rejects invalid non-empty treatment override %s=%s", (name, value) => {
    expect(() => requiresEmbeddingTreatmentDiagnostics({ [name]: value }))
      .toThrow(new RegExp(name, "u"));
  });

  it("derives the persisted embedding schema from the production D2Q switch", () => {
    expect(resolveBenchEmbeddingSchemaVersion("local_onnx", { ALAYA_RECALL_D2Q: "true" })).toBe(2);
    expect(resolveBenchEmbeddingSchemaVersion("local_onnx", { ALAYA_RECALL_D2Q: "1" })).toBe(2);
    expect(resolveBenchEmbeddingSchemaVersion("local_onnx", { ALAYA_RECALL_D2Q: "false" })).toBe(1);
    expect(resolveBenchEmbeddingSchemaVersion("local_onnx", {})).toBe(1);
    expect(resolveBenchEmbeddingSchemaVersion("openai", { ALAYA_RECALL_D2Q: "true" })).toBe(1);
    expect(() => resolveBenchEmbeddingSchemaVersion(
      "local_onnx", { ALAYA_RECALL_D2Q: "enabled" }
    ))
      .toThrow(/ALAYA_RECALL_D2Q/u);
  });

  it("follows product local_onnx admission when recall-eval mode is unset", () => {
    expect(recallEvalEmbeddingMode({})).toBe("env");
    expect(recallEvalEmbeddingMode({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false" }))
      .toBe("disabled");
    expect(recallEvalEmbeddingMode({ ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }))
      .toBe("env");
  });

  it("honors explicit recall-eval embedding modes", () => {
    expect(recallEvalEmbeddingMode({ ALAYA_RECALL_EVAL_EMBEDDING: "disabled" }))
      .toBe("disabled");
    expect(recallEvalEmbeddingMode({
      ALAYA_RECALL_EVAL_EMBEDDING: "disabled",
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true"
    })).toBe("disabled");
    expect(recallEvalEmbeddingMode({ ALAYA_RECALL_EVAL_EMBEDDING: "env" })).toBe("env");
    expect(() => recallEvalEmbeddingMode({ ALAYA_RECALL_EVAL_EMBEDDING: "local" }))
      .toThrow(/ALAYA_RECALL_EVAL_EMBEDDING/u);
  });

  it("opens the product local_onnx supplement when recall-eval follows admission", () => {
    const embeddingMode = recallEvalEmbeddingMode({});
    expect(embeddingMode).toBe("env");
    const launch = createBenchDaemonLaunchConfig({
      dataDir: "/tmp/bench-product-embed-admission",
      embeddingMode,
      embeddingProviderKind: recallEvalEmbeddingProviderKind({}),
      reviewerIdentity: "user:test",
      reviewerToken: "test-token",
      ambientEnv: {}
    });
    expect(launch.environment.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT).toBe("true");
    expect(launch.environment.ALAYA_EMBEDDING_PROVIDER).toBe("local_onnx");
  });

  it("pins OpenAI explicitly and rejects invalid threads before mutation", () => {
    const managedEnvKeys = resolveBenchDaemonManagedEnvKeys({}, process.env);
    const saved = Object.fromEntries(
      managedEnvKeys.map((key) => [key, process.env[key]])
    );
    const input = {
      dataDir: "/tmp/bench-env-test",
      embeddingMode: "env" as const,
      embeddingProviderKind: "openai" as const,
      reviewerIdentity: "user:test",
      reviewerToken: "test-token"
    };
    try {
      process.env.DATA_DIR = "unchanged";
      process.env.OPENAI_API_KEY = "fixture-key";
      expect(() => createBenchDaemonLaunchConfig({
        ...input,
        ambientEnv: {
          ALAYA_LOCAL_ONNX_THREADS: "65",
          OPENAI_API_KEY: "fixture-key"
        }
      })).toThrow(/ALAYA_LOCAL_ONNX_THREADS/u);
      expect(process.env.DATA_DIR).toBe("unchanged");
      const launch = createBenchDaemonLaunchConfig({
        ...input,
        ambientEnv: {
          ALAYA_LOCAL_ONNX_THREADS: "2",
          OPENAI_API_KEY: "fixture-key"
        }
      });
      applyBenchDaemonEnvironment(launch.environment, managedEnvKeys);
      expect(process.env.ALAYA_EMBEDDING_PROVIDER).toBe("openai");
      expect(process.env.ALAYA_LOCAL_ONNX_THREADS).toBe("2");
    } finally {
      for (const key of managedEnvKeys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
