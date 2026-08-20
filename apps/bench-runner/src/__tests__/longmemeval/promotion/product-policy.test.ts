import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import { LongMemEvalDiagnosticsSpool } from "../../../bench/diagnostics/spool.js";
import type { LongMemEvalRunProvenance } from "../../../bench/provenance/run.js";
import { prepareLongMemEvalRun } from "../../../longmemeval/runner/prepare-context.js";
import { assertSnapshotProducerInvocationPolicy } from
  "../../../longmemeval/runner/policy/snapshot-producer-policy.js";
import { assertProductFormationEnvironment } from
  "../../../longmemeval/promotion/product/product-formation-policy.js";
import {
  assertProductDefaultRunProvenancePolicy,
  canonicalProductRecallProvenanceConfig
} from "../../../longmemeval/promotion/verifiers/product-policy-verifier.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("product formation fail-closed gate", () => {
  it("accepts omitted knobs and explicit product-default tokens", () => {
    expect(() => assertProductFormationEnvironment({}, "formation")).not.toThrow();
    expect(() => assertProductFormationEnvironment({
      ALAYA_INGEST_RECONCILIATION_ENABLED: "1",
      ALAYA_CONFLICT_DETECTION_ENABLED: "true",
      ALAYA_CONFLICT_RULE_ENABLED: "on",
      ALAYA_GARDEN_PROVIDER_KIND: "host_worker",
      ALAYA_RETAIN_UNROUTED_FACTS: "yes",
      ALAYA_EVIDENCE_FULL_TURN: "enabled",
      ALAYA_MATERIALIZATION_CONF_FLOOR: "0.5",
      ALAYA_EDGE_PRODUCER_LLM_ENABLED: "0",
      ALAYA_EDGE_CLASSIFY_HOST_WORKER: "true",
      ALAYA_PATHREL_COUNTER_TTL_MS: "86400000"
    }, "formation")).not.toThrow();
  });

  it.each([
    ["ALAYA_MATERIALIZATION_CONF_FLOOR", "invalid"],
    ["ALAYA_MATERIALIZATION_CONF_FLOOR", "1.5"],
    ["ALAYA_PATHREL_COUNTER_TTL_MS", "not-a-ttl"],
    ["ALAYA_PATHREL_COUNTER_TTL_MS", "0"],
    ["ALAYA_GARDEN_PROVIDER_KIND", "not-a-provider"],
    ["ALAYA_INGEST_RECONCILIATION_ENABLED", "garbage"],
    ["ALAYA_EDGE_PRODUCER_LLM_ENABLED", "maybe"],
    ["ALAYA_EDGE_CLASSIFY_HOST_WORKER", "auto"]
  ] as const)("rejects present-but-unparseable %s=%j", (key, value) => {
    expect(() => assertProductFormationEnvironment({ [key]: value }, "formation"))
      .toThrow(new RegExp(`${key}|product formation|finite number|garden provider`, "u"));
  });

  it.each([
    ["ALAYA_INGEST_RECONCILIATION_ENABLED", "0"],
    ["ALAYA_GARDEN_PROVIDER_KIND", "local_heuristics"],
    ["ALAYA_MATERIALIZATION_CONF_FLOOR", "0.7"],
    ["ALAYA_EDGE_PRODUCER_LLM_ENABLED", "true"]
  ] as const)("rejects drifted %s=%j", (key, value) => {
    expect(() => assertProductFormationEnvironment({ [key]: value }, "formation"))
      .toThrow(/product formation/u);
  });
});

describe("snapshot producer product formation before I/O", () => {
  it("rejects unparseable formation env at the invocation policy", () => {
    expect(() => assertSnapshotProducerInvocationPolicy(snapshotProducerInput(), {
      ALAYA_MATERIALIZATION_CONF_FLOOR: "invalid"
    })).toThrow(/ALAYA_MATERIALIZATION_CONF_FLOOR|finite number/u);
  });

  it("rejects unparseable formation env before reading snapshot inputs", async () => {
    vi.stubEnv("ALAYA_MATERIALIZATION_CONF_FLOOR", "invalid");
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(prepareLongMemEvalRun({
        variant: "longmemeval_oracle",
        historyRoot: "/missing/history",
        dataDir: "/missing/dataset",
        snapshotOut: "/missing/snapshot.db",
        embeddingMode: "disabled"
      }, undefined, spool)).rejects.toThrow(/ALAYA_MATERIALIZATION_CONF_FLOOR|finite number/u);
    } finally {
      await spool.dispose();
    }
  });

  it("reaches dataset I/O when formation env is product-default", async () => {
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(prepareLongMemEvalRun({
        variant: "longmemeval_oracle",
        historyRoot: "/missing/history",
        dataDir: "/missing/dataset",
        snapshotOut: "/missing/snapshot.db",
        embeddingMode: "disabled"
      }, undefined, spool)).rejects.toThrow(/ENOENT|no such file|dataset/u);
    } finally {
      await spool.dispose();
    }
  });
});

describe("product-default run provenance policy", () => {
  it("accepts product embedding-on identity with omitted seed capabilities", () => {
    expect(() => assertProductDefaultRunProvenancePolicy(
      productDefaultProvenance(),
      "policy"
    )).not.toThrow();
  });

  it("accepts explicit product-off facet tags", () => {
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...productDefaultProvenance(),
      seed_capabilities: { facet_tags_enabled: false }
    }, "policy")).not.toThrow();
  });

  it("rejects seed capabilities that enable facet tags", () => {
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...productDefaultProvenance(),
      seed_capabilities: { facet_tags_enabled: true }
    }, "policy")).toThrow(/seed capabilities/u);
  });

  it("treats omitted and explicit-disabled answer_rerank as product-off", () => {
    const provenance = productDefaultProvenance();
    const { answer_rerank: _omitted, ...runtime } = provenance.runtime;
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...provenance,
      runtime
    }, "policy")).not.toThrow();
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...provenance,
      runtime: { ...provenance.runtime, answer_rerank: { enabled: false } }
    }, "policy")).not.toThrow();
  });

  it("rejects drifted enabled answer_rerank", () => {
    const provenance = productDefaultProvenance();
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...provenance,
      runtime: {
        ...provenance.runtime,
        answer_rerank: {
          enabled: true,
          provider_kind: "local_onnx_cross_encoder",
          effective_model_id: "Xenova/reranker",
          model_artifact_sha256: "a".repeat(64)
        }
      }
    }, "policy")).toThrow(/bi-encoder runtime/u);
  });

  it("rejects embedding-off compact identity", () => {
    const provenance = productDefaultProvenance();
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...provenance,
      runtime: {
        ...provenance.runtime,
        embedding_mode: "disabled",
        embedding_supplement: { enabled: false }
      }
    }, "policy")).toThrow(/bi-encoder identity/u);
  });

  it("rejects a drifted embedding model", () => {
    const provenance = productDefaultProvenance();
    expect(() => assertProductDefaultRunProvenancePolicy({
      ...provenance,
      runtime: {
        ...provenance.runtime,
        embedding_provider_label: "local_onnx:Xenova/other",
        embedding_supplement: {
          ...provenance.runtime.embedding_supplement!,
          enabled: true,
          provider_kind: "local_onnx",
          effective_model_id: "Xenova/other"
        }
      }
    }, "policy")).toThrow(/bi-encoder/u);
  });
});

function snapshotProducerInput() {
  return {
    opts: {
      variant: "longmemeval_oracle" as const,
      historyRoot: "/missing/history",
      snapshotOut: "/missing/snapshot.db",
      embeddingMode: "disabled" as const
    },
    policyShape: "stress" as const,
    simulateReport: "none" as const,
    recallWeightOverrides: undefined,
    releaseEvidenceAuthority: null
  };
}

function productDefaultProvenance(): Pick<
  LongMemEvalRunProvenance,
  "runtime" | "recall_config" | "seed_capabilities"
> {
  const modelArtifactSha256 = "f".repeat(64);
  return {
    recall_config: canonicalProductRecallProvenanceConfig(),
    runtime: {
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "env",
      embedding_provider_kind: "local_onnx",
      embedding_provider_label: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
      onnx_threads: null,
      onnx_model_artifact_sha256: modelArtifactSha256,
      embedding_supplement: {
        enabled: true,
        provider_kind: "local_onnx",
        effective_model_id: DEFAULT_LOCAL_ONNX_MODEL_ID,
        model_artifact_sha256: modelArtifactSha256,
        effective_schema_version: 1,
        d2q_input: "raw_content"
      },
      answer_rerank: { enabled: false },
      paired_env: {}
    }
  };
}
